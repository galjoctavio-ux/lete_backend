import psycopg2
import paho.mqtt.client as mqtt
import os
import json
import time
from dotenv import load_dotenv
from datetime import datetime, timezone

# --- ¡NUEVAS LIBRERÍAS PARA INFLUXDB! ---
from influxdb_client import InfluxDBClient, Point, WritePrecision
from influxdb_client.client.write_api import SYNCHRONOUS
from influxdb_client.client.exceptions import InfluxDBError

# --- 1. Carga de Configuración ---
load_dotenv()

# Configuración de Supabase (PostgreSQL)
DB_HOST = os.environ.get("DB_HOST")
DB_USER = os.environ.get("DB_USER")
DB_PASS = os.environ.get("DB_PASS")
DB_NAME = os.environ.get("DB_NAME")

# Configuración de MQTT
MQTT_BROKER_HOST = os.environ.get("MQTT_BROKER_HOST")
MQTT_PORT = int(os.environ.get("MQTT_PORT", 1883))
# --- ¡CORRECCIÓN! ---
# Faltaba cargar estas variables.
MQTT_USERNAME = os.environ.get("MQTT_USERNAME")
MQTT_PASSWORD = os.environ.get("MQTT_PASSWORD")

# --- ¡NUEVA CONFIGURACIÓN DE INFLUXDB! ---
INFLUX_URL = os.environ.get("INFLUX_URL")
INFLUX_TOKEN = os.environ.get("INFLUX_TOKEN")
INFLUX_ORG = os.environ.get("INFLUX_ORG")
INFLUX_BUCKET_NEW = os.environ.get("INFLUX_BUCKET_NEW") # <-- Usamos el nuevo bucket

# Topics de MQTT
TOPIC_BOOT = "lete/dispositivos/boot_time"
TOPIC_MEDICIONES = "lete/mediciones/+"

# Clientes y Conexiones Globales
db_conn = None
influx_client = None
influx_write_api = None

# --- 2. Lógica de Base de Datos (PostgreSQL) ---

def connect_db():
    """Conecta (o reconecta) a la base de datos PostgreSQL."""
    global db_conn
    while True:
        try:
            if db_conn and not db_conn.closed:
                db_conn.close()
            print(f"Conectando a PostgreSQL en {DB_HOST}...")
            db_conn = psycopg2.connect(
                host=DB_HOST,
                user=DB_USER,
                password=DB_PASS,
                dbname=DB_NAME
            )
            db_conn.autocommit = True
            print("✅ Conexión con PostgreSQL (Supabase) exitosa.")
            return
        except psycopg2.OperationalError as e:
            print(f"❌ Error al conectar con PostgreSQL: {e}. Reintentando...")
            time.sleep(5)

def setup_database_schema():
    """Asegura que la tabla de BOOT SESSIONS exista en PostgreSQL."""
    if not db_conn or db_conn.closed:
        connect_db()
    try:
        with db_conn.cursor() as cursor:
            print("Verificando esquema de PostgreSQL...")
            
            # Tabla para almacenar la última hora de arranque de cada dispositivo
            # ¡LA TABLA 'mediciones' YA NO SE CREA AQUÍ!
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS dispositivo_boot_sessions (
                    device_id VARCHAR(20) PRIMARY KEY,
                    boot_time_unix BIGINT NOT NULL,
                    last_updated TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            print("✅ Esquema de PostgreSQL (boot_sessions) verificado.")
    
    except psycopg2.Error as e:
        print(f"❌ ERROR al configurar el esquema de PostgreSQL: {e}")
        connect_db()

# --- 3. Lógica de InfluxDB ---

def connect_influx():
    """Conecta (o reconecta) a InfluxDB."""
    global influx_client, influx_write_api
    max_retries = 3
    retry_count = 0
    
    while retry_count < max_retries:
        try:
            print(f"Conectando a InfluxDB en {INFLUX_URL}...")
            influx_client = InfluxDBClient(
                url=INFLUX_URL, 
                token=INFLUX_TOKEN, 
                org=INFLUX_ORG,
                timeout=10_000
            )
            
            # Usar ping() en lugar de health().status
            if influx_client.ping():
                influx_write_api = influx_client.write_api(write_options=SYNCHRONOUS)
                print(f"✅ Conexión con InfluxDB exitosa. Escribiendo en bucket: '{INFLUX_BUCKET_NEW}'")
                return
            else:
                print("❌ InfluxDB no respondió al ping.")
                retry_count += 1
                if retry_count < max_retries:
                    print(f"Reintentando... ({retry_count}/{max_retries})")
                    time.sleep(5)
                
        except Exception as e:
            print(f"❌ Error al conectar con InfluxDB: {e}")
            retry_count += 1
            if retry_count < max_retries:
                print(f"Reintentando... ({retry_count}/{max_retries})")
                time.sleep(5)
    
    # Si llegamos aquí, falló después de todos los reintentos
    raise Exception(f"No se pudo conectar a InfluxDB después de {max_retries} intentos")

# --- 4. Lógica de Handlers de MQTT ---

def handle_boot_time(payload_str):
    """Procesa el mensaje de arranque y lo guarda en PostgreSQL."""
    try:
        data = json.loads(payload_str)
        device_id = data.get('device_id')
        boot_time_unix = data.get('boot_time_unix')

        if not device_id or not boot_time_unix:
            print(f"⚠️ Mensaje de boot inválido: {payload_str}")
            return

        print(f"-> [PostgreSQL] Recibido reporte de arranque de: {device_id}")

        sql = """
            INSERT INTO dispositivo_boot_sessions (device_id, boot_time_unix, last_updated)
            VALUES (%s, %s, NOW())
            ON CONFLICT (device_id) DO UPDATE
            SET boot_time_unix = EXCLUDED.boot_time_unix,
                last_updated = NOW()
        """
        
        with db_conn.cursor() as cursor:
            cursor.execute(sql, (device_id, boot_time_unix))
            
    except json.JSONDecodeError:
        print(f"❌ ERROR: Mensaje de boot no es un JSON válido: {payload_str}")
    except psycopg2.Error as e:
        print(f"❌ ERROR de PostgreSQL en handle_boot_time: {e}")
        connect_db() # Si falla, reconectamos
    except Exception as e:
        print(f"❌ ERROR inesperado en handle_boot_time: {e}")


def handle_medicion(payload_str, device_id):
    """Procesa una medición, corrige el timestamp y la guarda en InfluxDB."""
    try:
        data = json.loads(payload_str)
        ts_millis = data.get('ts_millis')

        if ts_millis is None:
            print(f"⚠️ Mensaje de medición inválido (sin ts_millis): {payload_str}")
            return
            
        # 1. Obtener el boot_time para este dispositivo (desde PostgreSQL)
        boot_time_unix = None
        with db_conn.cursor() as cursor:
            cursor.execute(
                "SELECT boot_time_unix FROM dispositivo_boot_sessions WHERE device_id = %s",
                (device_id,)
            )
            result = cursor.fetchone()
            if result:
                boot_time_unix = result[0]

        if boot_time_unix is None:
            print(f"⚠️ Advertencia: Medición de {device_id} recibida pero no hay boot_time. Descartando.")
            return

        # 2. Corregir el timestamp
        timestamp_real_seconds = boot_time_unix + (ts_millis / 1000.0)
        timestamp_real_dt = datetime.fromtimestamp(timestamp_real_seconds, tz=timezone.utc)

        # 3. Preparar el punto de datos para InfluxDB
        point = Point("energia") \
            .tag("device_id", device_id) \
            .field("vrms", data.get('vrms')) \
            .field("irms_phase", data.get('irms_p')) \
            .field("irms_neutral", data.get('irms_n')) \
            .field("power", data.get('pwr')) \
            .field("va", data.get('va')) \
            .field("power_factor", data.get('pf')) \
            .field("leakage", data.get('leak')) \
            .field("temp_cpu", data.get('temp')) \
            .field("sequence", data.get('seq')) \
            .time(timestamp_real_dt, WritePrecision.NS)
        
        # 4. Escribir en InfluxDB
        influx_write_api.write(bucket=INFLUX_BUCKET_NEW, org=INFLUX_ORG, record=point)
        print(f"-> [InfluxDB] Medición guardada de {device_id} @ {timestamp_real_dt}")

    except json.JSONDecodeError:
        print(f"❌ ERROR: Mensaje de medición no es un JSON válido: {payload_str}")
    except InfluxDBError as e:
        print(f"❌ ERROR de InfluxDB en handle_medicion: {e}")
        # Si Influx falla, reconectamos
        connect_influx()
    except psycopg2.Error as e:
        print(f"❌ ERROR de PostgreSQL en handle_medicion: {e}")
        connect_db()
    except Exception as e:
        print(f"❌ ERROR inesperado en handle_medicion: {e}")


# --- 5. Lógica de Conexión MQTT ---

def on_connect(client, userdata, flags, rc):
    """Callback que se ejecuta cuando nos conectamos al broker."""
    if rc == 0:
        print(f"✅ Conectado al broker MQTT en {MQTT_BROKER_HOST}")
        client.subscribe(TOPIC_BOOT)
        client.subscribe(TOPIC_MEDICIONES)
        print(f"Suscrito a: {TOPIC_BOOT}")
        print(f"Suscrito a: {TOPIC_MEDICIONES}")
    else:
        print(f"❌ Fallo al conectar al broker MQTT. Código de retorno: {rc}")

def on_message(client, userdata, msg):
    """Callback que se ejecuta cuando llega un mensaje."""
    try:
        payload_str = msg.payload.decode('utf-8')
        
        if msg.topic == TOPIC_BOOT:
            handle_boot_time(payload_str)
        
        elif msg.topic.startswith('lete/mediciones/'):
            topic_parts = msg.topic.split('/')
            if len(topic_parts) == 3:
                device_id = topic_parts[2]
                handle_medicion(payload_str, device_id)
            else:
                print(f"⚠️ Topic de medición malformado: {msg.topic}")
                
    except Exception as e:
        print(f"❌ ERROR fatal en on_message: {e}")


# --- 6. Ejecución Principal ---

def main():
    # 1. Conectar a las bases de datos
    connect_db()
    connect_influx()
    
    # 2. Asegurar que la tabla de boot (en PostgreSQL) exista
    setup_database_schema()

    # 3. Configurar cliente MQTT
    
    # --- ¡CORRECCIÓN! ---
    # Especificamos la V1 de la API para que coincida con tus callbacks
    # y para silenciar el DeprecationWarning.
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1, client_id="receptor_servidor_lete")
    
    # Configurar autenticación si existe
    # Ahora 'MQTT_USERNAME' y 'MQTT_PASSWORD' existen (serán None si no están en el .env)
    if MQTT_USERNAME and MQTT_PASSWORD:
        client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)

    client.on_connect = on_connect
    client.on_message = on_message

    # Conectar al broker
    while True:
        try:
            print(f"Conectando a MQTT en {MQTT_BROKER_HOST}...")
            client.connect(MQTT_BROKER_HOST, MQTT_PORT, 60)
            break 
        except Exception as e:
            print(f"❌ Error de conexión MQTT: {e}. Reintentando en 5s...")
            time.sleep(5)
            
    # 4. Iniciar bucle de escucha
    print("Iniciando bucle de escucha MQTT...")
    try:
        client.loop_forever()
    except KeyboardInterrupt:
        print("\nCerrando script...")
    finally:
        if db_conn and not db_conn.closed:
            db_conn.close()
            print("🔌 Conexión con PostgreSQL cerrada.")
        if influx_client:
            influx_client.close()
            print("🔌 Conexión con InfluxDB cerrada.")
        client.disconnect()
        print("🔌 Desconectado de MQTT.")

if __name__ == "__main__":
    main()
