#!/usr/bin/env python3

"""
RECEPTOR MQTT -> INFLUXDB (v3 - PRODUCCIÓN)

Este script actúa como un servicio intermediario que:
1. Escucha mensajes MQTT provenientes de dispositivos ESP32.
2. Maneja los reportes de arranque ('boot_time') y los guarda en PostgreSQL.
3. Acumula las mediciones en un buffer (batching) de forma segura (thread-safe).
4. Envía los lotes de mediciones a InfluxDB de forma eficiente y robusta.
5. Utiliza 'logging' para un monitoreo de nivel de producción.
6. Carga toda la configuración desde un archivo .env.
"""

# --- 1. LIBRERÍAS ---
import psycopg2
import paho.mqtt.client as mqtt
import os
import json
import time
import logging
import sys
import threading
from dotenv import load_dotenv
from datetime import datetime, timezone
from collections import deque

# Librerías para InfluxDB
from influxdb_client import InfluxDBClient, Point, WritePrecision
from influxdb_client.client.write_api import SYNCHRONOUS
from influxdb_client.client.exceptions import InfluxDBError

# --- 2. Carga de Configuración ---
load_dotenv()

# Configuración de Logging
# (Se configurará en main() para asegurar que se ejecute primero)
logger = logging.getLogger(__name__)

# Configuración de Supabase (PostgreSQL)
DB_HOST = os.environ.get("DB_HOST")
DB_USER = os.environ.get("DB_USER")
DB_PASS = os.environ.get("DB_PASS")
DB_NAME = os.environ.get("DB_NAME")

# Configuración de MQTT
MQTT_BROKER_HOST = os.environ.get("MQTT_BROKER_HOST")
MQTT_PORT = int(os.environ.get("MQTT_PORT", 1883))
MQTT_USERNAME = os.environ.get("MQTT_USERNAME")
MQTT_PASSWORD = os.environ.get("MQTT_PASSWORD")

# Configuración de InfluxDB
INFLUX_URL = os.environ.get("INFLUX_URL")
INFLUX_TOKEN = os.environ.get("INFLUX_TOKEN")
INFLUX_ORG = os.environ.get("INFLUX_ORG")
INFLUX_BUCKET_NEW = os.environ.get("INFLUX_BUCKET_NEW")

# Topics de MQTT
TOPIC_BOOT = "lete/dispositivos/boot_time"
TOPIC_MEDICIONES = "lete/mediciones/+"

# Configuración de Batching (desde .env)
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", 50))
BATCH_TIMEOUT = int(os.environ.get("BATCH_TIMEOUT", 10))
MAX_RETRY_ATTEMPTS = int(os.environ.get("MAX_RETRY_ATTEMPTS", 3))

# --- 3. Clientes y Conexiones Globales ---
db_conn = None
influx_client = None
influx_write_api = None

# Buffer para batching (thread-safe)
measurement_buffer = deque()
buffer_lock = threading.Lock()
last_flush_time = time.time()

# --- 4. Lógica de Base de Datos (PostgreSQL) ---

def connect_db():
    """Conecta (o reconecta) a la base de datos PostgreSQL."""
    global db_conn
    max_retries = 3
    retry_count = 0
    
    while retry_count < max_retries:
        try:
            if db_conn and not db_conn.closed:
                db_conn.close()
            logger.info(f"Conectando a PostgreSQL en {DB_HOST}...")
            db_conn = psycopg2.connect(
                host=DB_HOST,
                user=DB_USER,
                password=DB_PASS,
                dbname=DB_NAME,
                connect_timeout=10
            )
            db_conn.autocommit = True
            logger.info("✅ Conexión con PostgreSQL (Supabase) exitosa.")
            return True
        except psycopg2.OperationalError as e:
            retry_count += 1
            logger.error(f"❌ Error al conectar con PostgreSQL: {e}")
            if retry_count < max_retries:
                logger.warning(f"Reintentando... ({retry_count}/{max_retries})")
                time.sleep(5)
    
    logger.critical(f"❌ CRÍTICO: No se pudo conectar a PostgreSQL después de {max_retries} intentos")
    return False

def setup_database_schema():
    """Asegura que la tabla de BOOT SESSIONS exista en PostgreSQL."""
    if not db_conn or db_conn.closed:
        if not connect_db():
            return False
    try:
        with db_conn.cursor() as cursor:
            logger.info("Verificando esquema de PostgreSQL...")
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS dispositivo_boot_sessions (
                    device_id VARCHAR(20) PRIMARY KEY,
                    boot_time_unix BIGINT NOT NULL,
                    last_updated TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            logger.info("✅ Esquema de PostgreSQL verificado.")
            return True
    except psycopg2.Error as e:
        logger.error(f"❌ ERROR al configurar el esquema: {e}")
        connect_db()
        return False

# --- 5. Lógica de InfluxDB ---

def connect_influx():
    """Conecta (o reconecta) a InfluxDB."""
    global influx_client, influx_write_api
    max_retries = 3
    retry_count = 0
    
    while retry_count < max_retries:
        try:
            logger.info(f"Conectando a InfluxDB en {INFLUX_URL}...")
            influx_client = InfluxDBClient(
                url=INFLUX_URL, 
                token=INFLUX_TOKEN, 
                org=INFLUX_ORG,
                timeout=15_000  # 15 segundos
            )
            
            if influx_client.ping():
                influx_write_api = influx_client.write_api(write_options=SYNCHRONOUS)
                logger.info(f"✅ Conexión con InfluxDB exitosa. Bucket: '{INFLUX_BUCKET_NEW}'")
                return True
            else:
                logger.warning("❌ InfluxDB no respondió al ping.")
                retry_count += 1
                
        except Exception as e:
            logger.error(f"❌ Error al conectar con InfluxDB: {e}")
            retry_count += 1
            
        if retry_count < max_retries:
            logger.warning(f"Reintentando... ({retry_count}/{max_retries})")
            time.sleep(5)
    
    logger.critical(f"❌ CRÍTICO: No se pudo conectar a InfluxDB después de {max_retries} intentos")
    return False

def flush_buffer_to_influx():
    """Envía todas las mediciones acumuladas a InfluxDB en un solo batch."""
    global last_flush_time
    
    with buffer_lock:
        if len(measurement_buffer) == 0:
            return True
        
        # Copiar el buffer y vaciarlo inmediatamente
        points_to_send = list(measurement_buffer)
        measurement_buffer.clear()
    
    logger.info(f"📤 Enviando batch de {len(points_to_send)} mediciones a InfluxDB...")
    
    for attempt in range(MAX_RETRY_ATTEMPTS):
        try:
            influx_write_api.write(
                bucket=INFLUX_BUCKET_NEW, 
                org=INFLUX_ORG, 
                record=points_to_send
            )
            logger.info(f"✅ Batch enviado exitosamente ({len(points_to_send)} puntos)")
            last_flush_time = time.time()
            return True
            
        except InfluxDBError as e:
            logger.error(f"❌ ERROR de InfluxDB (intento {attempt+1}/{MAX_RETRY_ATTEMPTS}): {e}")
            if attempt < MAX_RETRY_ATTEMPTS - 1:
                time.sleep(2 ** attempt)  # Backoff exponencial
            else:
                # Si falla después de todos los intentos, reconectar
                logger.warning("🔄 Reconectando a InfluxDB...")
                if connect_influx():
                    # Último intento después de reconectar
                    try:
                        influx_write_api.write(
                            bucket=INFLUX_BUCKET_NEW, 
                            org=INFLUX_ORG, 
                            record=points_to_send
                        )
                        logger.info(f"✅ Batch enviado tras reconexión")
                        last_flush_time = time.time()
                        return True
                    except Exception as e2:
                        logger.critical(f"❌ CRÍTICO: Fallo final al enviar batch: {e2}")
                        # Re-añadir al buffer para no perder datos
                        with buffer_lock:
                            measurement_buffer.extendleft(reversed(points_to_send))
                        return False
        except Exception as e:
            logger.exception(f"❌ ERROR inesperado en flush. Devolviendo datos al buffer.")
            with buffer_lock:
                measurement_buffer.extendleft(reversed(points_to_send))
            return False
    
    return False

def check_and_flush_buffer():
    """Verifica si el buffer debe ser enviado (por tamaño o timeout)."""
    global last_flush_time
    
    should_flush = False
    with buffer_lock:
        buffer_size = len(measurement_buffer)
        if buffer_size >= BATCH_SIZE:
            should_flush = True
            reason = f"tamaño ({buffer_size}/{BATCH_SIZE})"
        elif buffer_size > 0 and (time.time() - last_flush_time) >= BATCH_TIMEOUT:
            should_flush = True
            reason = f"timeout ({int(time.time() - last_flush_time)}s)"
    
    if should_flush:
        logger.info(f"🔔 Flush disparado por {reason}")
        flush_buffer_to_influx()

# --- 6. Handlers de MQTT ---

def handle_boot_time(payload_str):
    """Procesa el mensaje de arranque y lo guarda en PostgreSQL."""
    try:
        data = json.loads(payload_str)
        device_id = data.get('device_id')
        boot_time_unix = data.get('boot_time_unix')

        if not device_id or not boot_time_unix:
            logger.warning(f"⚠️ Mensaje de boot inválido: {payload_str}")
            return

        boot_time_dt = datetime.fromtimestamp(boot_time_unix, tz=timezone.utc)
        logger.info(f"🔔 Reporte de arranque: {device_id} @ {boot_time_dt}")

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
        logger.error(f"❌ ERROR: Boot no es JSON válido: {payload_str}")
    except psycopg2.Error as e:
        logger.error(f"❌ ERROR PostgreSQL en handle_boot_time: {e}")
        connect_db()
    except Exception:
        logger.exception("❌ ERROR inesperado en handle_boot_time")


def handle_medicion(payload_str, device_id):
    """Procesa una medición con timestamp Unix y la agrega al buffer."""
    try:
        data = json.loads(payload_str)
        ts_unix = data.get('ts_unix')  # <-- ¡Cambiado! Ahora viene en Unix

        if ts_unix is None:
            logger.warning(f"⚠️ Medición inválida (sin ts_unix): {payload_str}")
            return
        
        # Convertir el timestamp Unix a un objeto datetime
        timestamp_dt = datetime.fromtimestamp(ts_unix, tz=timezone.utc)

        # Crear el punto de datos para InfluxDB
        # Se añaden conversiones float() e int() para mayor robustez
        point = Point("energia") \
            .tag("device_id", device_id) \
            .field("vrms", float(data.get('vrms', 0))) \
            .field("irms_phase", float(data.get('irms_p', 0))) \
            .field("irms_neutral", float(data.get('irms_n', 0))) \
            .field("power", float(data.get('pwr', 0))) \
            .field("va", float(data.get('va', 0))) \
            .field("power_factor", float(data.get('pf', 0))) \
            .field("leakage", float(data.get('leak', 0))) \
            .field("temp_cpu", float(data.get('temp', 0))) \
            .field("sequence", int(data.get('seq', 0))) \
            .time(timestamp_dt, WritePrecision.S)  # Precisión en segundos
        
        # Agregar al buffer (thread-safe)
        with buffer_lock:
            measurement_buffer.append(point)
        
        # Verificar si es momento de hacer flush
        check_and_flush_buffer()

    except json.JSONDecodeError:
        logger.error(f"❌ ERROR: Medición no es JSON válido: {payload_str}")
    except Exception:
        logger.exception("❌ ERROR inesperado en handle_medicion")


# --- 7. Lógica de Conexión MQTT ---

def on_connect(client, userdata, flags, rc):
    """Callback que se ejecuta cuando nos conectamos al broker."""
    if rc == 0:
        logger.info(f"✅ Conectado al broker MQTT en {MQTT_BROKER_HOST}")
        client.subscribe(TOPIC_BOOT)
        client.subscribe(TOPIC_MEDICIONES)
        logger.info(f"📡 Suscrito a: {TOPIC_BOOT}")
        logger.info(f"📡 Suscrito a: {TOPIC_MEDICIONES}")
    else:
        logger.error(f"❌ Fallo al conectar al broker MQTT. Código: {rc}")

def on_disconnect(client, userdata, rc):
    """Callback que se ejecuta cuando se pierde la conexión."""
    if rc != 0:
        logger.warning(f"⚠️ Desconexión inesperada del broker MQTT. Código: {rc}")
        logger.info("🔄 Intentando reconectar...")

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
                logger.warning(f"⚠️ Topic malformado: {msg.topic}")
                
    except Exception:
        logger.exception(f"❌ ERROR fatal en on_message procesando topic {msg.topic}")


# --- 8. Thread de Flush Periódico ---

def periodic_flush_thread():
    """Thread que fuerza el flush del buffer periódicamente."""
    while True:
        # Este chequeo es ligero, no necesita el lock aún
        time_since_last_flush = time.time() - last_flush_time
        
        if (time_since_last_flush > BATCH_TIMEOUT / 2):
            # Esperar un poco y luego chequear.
            # No queremos dormir los 10s completos, 
            # sino chequear más frecuentemente.
            time.sleep(1) 
            check_and_flush_buffer()
        else:
            # Si se acaba de hacer flush, dormir más tiempo
            time.sleep(BATCH_TIMEOUT / 2)

# --- 9. Ejecución Principal ---

def main():
    # --- Configuración del Logging ---
    # Nivel: INFO (captura info, warning, error, critical)
    # Formato: [Timestamp] - [Nivel] - [Módulo] - [Mensaje]
    # Salida: stdout (consola)
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(module)s - %(message)s',
        stream=sys.stdout
    )

    logger.info("=" * 60)
    logger.info("INICIANDO RECEPTOR LETE - v3 (PRODUCCIÓN)")
    logger.info("=" * 60)
    
    # 1. Conectar a las bases de datos
    if not connect_db():
        logger.critical("❌ CRÍTICO: No se pudo conectar a PostgreSQL. Abortando.")
        return
        
    if not connect_influx():
        logger.critical("❌ CRÍTICO: No se pudo conectar a InfluxDB. Abortando.")
        return
    
    # 2. Configurar esquema de PostgreSQL
    if not setup_database_schema():
        logger.critical("❌ CRÍTICO: No se pudo configurar el esquema. Abortando.")
        return

    # 3. Iniciar thread de flush periódico
    flush_thread = threading.Thread(target=periodic_flush_thread, daemon=True)
    flush_thread.start()
    logger.info("✅ Thread de flush periódico iniciado")

    # 4. Configurar cliente MQTT
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION1, 
        client_id="receptor_servidor_lete_v3"
    )
    
    if MQTT_USERNAME and MQTT_PASSWORD:
        client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message

    # Configuración de reconexión automática
    client.reconnect_delay_set(min_delay=1, max_delay=120)

    # 5. Conectar al broker
    while True:
        try:
            logger.info(f"Conectando a MQTT en {MQTT_BROKER_HOST}:{MQTT_PORT}...")
            client.connect(MQTT_BROKER_HOST, MQTT_PORT, 60)
            break 
        except Exception as e:
            logger.error(f"❌ Error de conexión MQTT: {e}. Reintentando en 5s...")
            time.sleep(5)
            
    # 6. Iniciar bucle de escucha
    logger.info("\n" + "=" * 60)
    logger.info("🚀 Sistema iniciado. Esperando mensajes MQTT...")
    logger.info(f"📊 Batching: {BATCH_SIZE} mediciones o {BATCH_TIMEOUT}s")
    logger.info("=" * 60 + "\n")
    
    try:
        client.loop_forever()
    except KeyboardInterrupt:
        logger.info("\n\n🛑 Detectado (Ctrl+C). Cerrando sistema...")
        # Flush final del buffer
        logger.info("📤 Enviando últimas mediciones pendientes...")
        flush_buffer_to_influx()
    except Exception:
        logger.exception("❌ ERROR CRÍTICO INESPERADO EN EL BUCLE PRINCIPAL")
    finally:
        if db_conn and not db_conn.closed:
            db_conn.close()
            logger.info("🔌 Conexión con PostgreSQL cerrada.")
        if influx_client:
            influx_client.close()
            logger.info("🔌 Conexión con InfluxDB cerrada.")
        client.disconnect()
        logger.info("🔌 Desconectado de MQTT.")
        logger.info("\n✅ Sistema detenido correctamente.\n")

if __name__ == "__main__":
    main()