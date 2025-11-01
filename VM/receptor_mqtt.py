#!/usr/bin/env python3

"""
RECEPTOR MQTT -> INFLUXDB (v5 - PRODUCCIÓN + ANTI-BLOQUEO)

Este script actúa como un servicio intermediario que:
1. Escucha mensajes MQTT provenientes de dispositivos ESP32.
2. Maneja los reportes de arranque ('boot_time') y los guarda en PostgreSQL.
3. Verifica el estado de suscripción del cliente (con caché).
4. Si está 'active', envía a InfluxDB (batching).
5. Si está en 'grace_period', guarda en una tabla 'mediciones_pendientes' en PostgreSQL.
6. Si está 'expired', descarta el dato.
7. Si la suscripción se reactiva, reenvía los datos pendientes a InfluxDB.
8. Si la suscripción expira (post-gracia), purga los datos pendientes.
9. [NUEVO] Mueve lotes "venenosos" (que Influx rechaza) a un archivo .log 
   en lugar de re-encolarlos, evitando bloqueos ("Poison Pill").
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
from datetime import datetime, timezone, timedelta
from collections import deque
from psycopg2.extras import execute_values 

# Librerías para InfluxDB
from influxdb_client import InfluxDBClient, Point, WritePrecision
from influxdb_client.client.write_api import SYNCHRONOUS
from influxdb_client.client.exceptions import InfluxDBError

# --- 2. Carga de Configuración ---
load_dotenv()

# Configuración de Logging
logger = logging.getLogger(__name__)

# Configuración de Supabase (PostgreSQL)
DB_HOST = os.environ.get("DB_HOST")
DB_USER = os.environ.get("DB_USER")
DB_PASS = os.environ.get("DB_PASS")
DB_NAME = os.environ.get("DB_NAME")
# String de conexión para threads (ya que psycopg2 no es thread-safe)
DB_CONN_STRING = f"host={DB_HOST} dbname={DB_NAME} user={DB_USER} password={DB_PASS}"

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

# --- Configuración de Lógica de Suscripción ---
CACHE_TTL_SECONDS = int(os.environ.get("CACHE_TTL_SECONDS", 300)) # 5 minutos
GRACE_PERIOD_DAYS = int(os.environ.get("GRACE_PERIOD_DAYS", 30))

# --- 3. Clientes y Conexiones Globales ---
db_conn = None
influx_client = None
influx_write_api = None

# Buffer para batching (thread-safe)
measurement_buffer = deque()
buffer_lock = threading.Lock()
last_flush_time = time.time()

# Caché de estados de suscripción (thread-safe)
device_status_cache = {}
cache_lock = threading.Lock()


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
            db_conn = psycopg2.connect(DB_CONN_STRING, connect_timeout=10)
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
    """Asegura que las tablas necesarias existan en PostgreSQL."""
    if not db_conn or db_conn.closed:
        if not connect_db():
            return False
    try:
        with db_conn.cursor() as cursor:
            logger.info("Verificando esquema de PostgreSQL...")
            
            # 1. Tabla de Sesiones de Arranque
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS dispositivo_boot_sessions (
                    device_id VARCHAR(20) PRIMARY KEY,
                    boot_time_unix BIGINT NOT NULL,
                    last_updated TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            
            # 2. Tabla de mediciones pendientes (para período de gracia)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS mediciones_pendientes (
                    id BIGSERIAL PRIMARY KEY,
                    device_id VARCHAR(20) NOT NULL,
                    ts_unix BIGINT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_mediciones_pendientes_device_id 
                ON mediciones_pendientes (device_id);
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_mediciones_pendientes_ts_unix
                ON mediciones_pendientes (ts_unix);
            """)

            logger.info("✅ Esquema de PostgreSQL verificado (boot_sessions y mediciones_pendientes).")
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

# --- [NUEVO] Helper Anti-Poison-Pill ---
def quarantine_failed_batch(points_to_send, original_exception, context_message):
    """
    Guarda un lote fallido en un archivo de 'cuarentena' en disco.
    Esto EVITA que un lote "venenoso" bloquee la pipeline.
    """
    try:
        # Convertir puntos a line protocol para loggear fácilmente
        failed_data = "\n".join([p.to_line_protocol() for p in points_to_send])
        
        # Usar un nombre de archivo único
        fail_filename = f"failed_batch_{int(time.time())}.log"
        
        with open(fail_filename, "w") as f:
            f.write(f"# Contexto: {context_message}\n")
            f.write(f"# Falla: {original_exception}\n")
            f.write(f"# Puntos: {len(points_to_send)}\n")
            f.write(failed_data)

        logger.warning(f"☣️ {context_message} ({len(points_to_send)} puntos) guardado en '{fail_filename}'. Descartando del buffer.")

    except Exception as log_e:
        logger.error(f"¡FALLO AL GUARDAR LOTE FALLIDO! ({context_message}): {log_e}")
    
    # Devolver False para indicar que el flush falló, pero NO se re-encola.
    return False

# --- [MODIFICADO] Lógica de InfluxDB con Anti-Bloqueo ---
def flush_buffer_to_influx():
    """
    Envía todas las mediciones acumuladas a InfluxDB en un solo batch.
    [v5] Incluye lógica anti-bloqueo ("Poison Pill").
    """
    global last_flush_time
    
    with buffer_lock:
        if len(measurement_buffer) == 0:
            return True
        
        points_to_send = list(measurement_buffer)
        measurement_buffer.clear()
    
    logger.info(f"📤 Enviando batch de {len(points_to_send)} mediciones a InfluxDB...")
    
    for attempt in range(MAX_RETRY_ATTEMPTS):
        try:
            # 1. Intento de escritura normal
            influx_write_api.write(
                bucket=INFLUX_BUCKET_NEW, 
                org=INFLUX_ORG, 
                record=points_to_send
            )
            logger.info(f"✅ Batch enviado exitosamente ({len(points_to_send)} puntos)")
            last_flush_time = time.time()
            return True # <-- ÉXITO
            
        except InfluxDBError as e:
            # 2. Error de InfluxDB (ej. Bad Request, schema inválido)
            logger.error(f"❌ ERROR de InfluxDB (intento {attempt+1}/{MAX_RETRY_ATTEMPTS}): {e}")
            if attempt < MAX_RETRY_ATTEMPTS - 1:
                time.sleep(2 ** attempt)  # Backoff exponencial
            else:
                # 3. Último intento falló. Probar reconexión...
                logger.warning("🔄 Reconectando a InfluxDB...")
                if connect_influx():
                    try:
                        # 4. Último intento después de reconectar
                        influx_write_api.write(
                            bucket=INFLUX_BUCKET_NEW, 
                            org=INFLUX_ORG, 
                            record=points_to_send
                        )
                        logger.info(f"✅ Batch enviado tras reconexión")
                        last_flush_time = time.time()
                        return True # <-- ÉXITO (tras reconexión)
                    
                    except Exception as e2:
                        # 5. [ANTI-BLOQUEO] Influx está UP, pero RECHAZÓ el lote.
                        # Esta es la "Poison Pill".
                        logger.critical(f"❌ CRÍTICO: Fallo final al enviar batch (post-reconexión): {e2}")
                        return quarantine_failed_batch(points_to_send, e2, "Fallo_Post_Reconexion")
                else:
                    # 6. [RE-ENCOLAR] Influx está DOWN. No es Poison Pill.
                    # Re-encolar es lo correcto.
                    logger.critical("❌ CRÍTICO: No se pudo reconectar a Influx. Re-encolando lote.")
                    with buffer_lock:
                        measurement_buffer.extendleft(reversed(points_to_send))
                    return False

        except Exception as e:
            # 7. Error inesperado (ej. network, bug en 'to_line_protocol', etc.)
            logger.exception(f"❌ ERROR inesperado en flush (intento {attempt+1}/{MAX_RETRY_ATTEMPTS})")
            if attempt < MAX_RETRY_ATTEMPTS - 1:
                time.sleep(2 ** attempt) # Backoff
            else:
                # 8. [ANTI-BLOQUEO] Fallo inesperado persistente.
                # Podría ser una "Poison Pill" (ej. bug de parseo).
                logger.critical(f"❌ CRÍTICO: Fallo inesperado final al enviar batch: {e}")
                return quarantine_failed_batch(points_to_send, e, "Fallo_Inesperado_Persistente")
    
    # 9. (Si el bucle termina) Fallo, re-encolar por seguridad.
    logger.error("El bucle de flush terminó inesperadamente. Re-encolando por seguridad.")
    with buffer_lock:
        measurement_buffer.extendleft(reversed(points_to_send))
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
        connect_db() # Intenta reconectar si falla
    except Exception:
        logger.exception("❌ ERROR inesperado en handle_boot_time")


def handle_medicion(payload_str, device_id):
    """
    Procesa una medición.
    Verifica el estado de la suscripción y decide si:
    1. Envía a InfluxDB (Active)
    2. Guarda en PostgreSQL (Grace Period)
    3. Descarta (Expired)
    """
    try:
        # 1. Obtener el estado de la suscripción (usando caché)
        status = get_device_subscription_status(device_id)

        # 2. Decidir acción basada en el estado
        if status == 'active':
            # ---------------------------------
            # ESTADO: ACTIVO -> Enviar a Influx
            # ---------------------------------
            point, _ = parse_payload_to_point(payload_str, device_id)
            if point:
                with buffer_lock:
                    measurement_buffer.append(point)
                check_and_flush_buffer()
            
        elif status == 'grace_period':
            # ---------------------------------
            # ESTADO: PERÍODO DE GRACIA -> Guardar localmente
            # ---------------------------------
            logger.info(f"Suscripción en gracia para {device_id}. Guardando en búfer local.")
            try:
                data = json.loads(payload_str)
                ts_unix = data.get('ts_unix')
                if ts_unix:
                    save_to_local_buffer(device_id, ts_unix, payload_str)
                else:
                    logger.warning(f"⚠️ Medición en gracia sin ts_unix: {payload_str}")
            except json.JSONDecodeError:
                logger.error(f"❌ ERROR: Medición (en gracia) no es JSON válido: {payload_str}")

        elif status == 'expired' or status == 'unknown':
            # ---------------------------------
            # ESTADO: EXPIRADO O DESCONOCIDO -> Descartar
            # ---------------------------------
            logger.info(f"Suscripción expirada/desconocida para {device_id}. Descartando datos.")
            # No hacer nada

    except Exception:
        logger.exception(f"❌ ERROR inesperado en handle_medicion para {device_id}")

# --- 7. Lógica de Suscripción y Búfer Local ---

def get_device_subscription_status(device_id):
    """
    Obtiene el estado de suscripción para un device_id.
    Usa un caché (thread-safe) para evitar consultas excesivas a la BD.
    Dispara acciones de reenvío o purga si el estado cambia.
    """
    global device_status_cache
    now = time.time()
    
    # 1. Revisar caché
    with cache_lock:
        cached_data = device_status_cache.get(device_id)
        if cached_data and cached_data['cached_until'] > now:
            return cached_data['status'] # Devolver estado cacheado

    # 2. Cache miss o expirado -> Consultar la BD
    logger.info(f"Cache miss para {device_id}. Consultando estado en PostgreSQL...")
    
    sql = """
        SELECT c.subscription_status, c.fecha_proximo_pago 
        FROM clientes c
        JOIN dispositivos_lete d ON c.id = d.cliente_id
        WHERE d.device_id = %s
    """
    
    new_status = 'unknown' # Default
    try:
        with db_conn.cursor() as cursor:
            cursor.execute(sql, (device_id,))
            result = cursor.fetchone()
            
        if not result:
            logger.warning(f"⚠️ No se encontró cliente para device_id {device_id}")
            new_status = 'unknown'
        else:
            sub_status, fecha_proximo_pago = result
            hoy = datetime.now(timezone.utc)
            
            if sub_status == 'active':
                new_status = 'active'
            elif fecha_proximo_pago is None:
                new_status = 'expired' # No activo y sin fecha de pago
            else:
                # El cliente no está 'active', verificar período de gracia
                grace_period_end = fecha_proximo_pago + timedelta(days=GRACE_PERIOD_DAYS)
                
                if hoy < grace_period_end:
                    new_status = 'grace_period'
                else:
                    new_status = 'expired' # El período de gracia terminó

    except psycopg2.Error as e:
        logger.error(f"❌ ERROR PostgreSQL en get_device_subscription_status: {e}")
        connect_db() # Reconectar
        return 'unknown' # Devolver 'unknown' en error de BD
    except Exception:
        logger.exception("❌ ERROR inesperado en get_device_subscription_status")
        return 'unknown'

    # 3. Lógica de Transición de Estado (Reenviar o Purgar)
    with cache_lock:
        old_status = device_status_cache.get(device_id, {}).get('status')
        
        if old_status == 'grace_period' and new_status == 'active':
            logger.info(f"🎉 ¡Suscripción reactivada para {device_id}! Iniciando reenvío de datos pendientes...")
            threading.Thread(target=resend_local_buffer, args=(device_id,), daemon=True).start()

        elif old_status == 'grace_period' and new_status == 'expired':
            logger.warning(f"🗑️ Período de gracia terminado para {device_id}. Purgando datos pendientes...")
            threading.Thread(target=delete_local_buffer, args=(device_id,), daemon=True).start()
    
        # 4. Actualizar caché
        device_status_cache[device_id] = {
            'status': new_status,
            'cached_until': now + CACHE_TTL_SECONDS
        }
    
    logger.info(f"Estado actualizado para {device_id}: {new_status} (Cacheado por {CACHE_TTL_SECONDS}s)")
    return new_status


def parse_payload_to_point(payload_str, device_id):
    """
    Función helper para convertir un payload JSON en un Point de Influx.
    Devuelve (Point, ts_unix) o (None, None) si falla.
    """
    try:
        data = json.loads(payload_str)
        ts_unix = data.get('ts_unix')

        if ts_unix is None:
            logger.warning(f"⚠️ Medición inválida (sin ts_unix): {payload_str}")
            return None, None
        
        timestamp_dt = datetime.fromtimestamp(ts_unix, tz=timezone.utc)

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
            .time(timestamp_dt, WritePrecision.S)
        
        return point, ts_unix
    
    except json.JSONDecodeError:
        logger.error(f"❌ ERROR: Medición (en parse) no es JSON válido: {payload_str}")
        return None, None
    except Exception:
        logger.exception("❌ ERROR inesperado en parse_payload_to_point")
        return None, None

def save_to_local_buffer(device_id, ts_unix, payload_str):
    """Guarda una medición en la tabla 'mediciones_pendientes'."""
    sql = """
        INSERT INTO mediciones_pendientes (device_id, ts_unix, payload_json)
        VALUES (%s, %s, %s)
    """
    try:
        with db_conn.cursor() as cursor:
            cursor.execute(sql, (device_id, ts_unix, payload_str))
    except psycopg2.Error as e:
        logger.error(f"❌ ERROR PostgreSQL en save_to_local_buffer: {e}")
        connect_db() # Reconectar
    except Exception:
        logger.exception("❌ ERROR inesperado en save_to_local_buffer")

def resend_local_buffer(device_id):
    """
    [EJECUTADO EN UN THREAD]
    Lee todas las mediciones pendientes de un device_id desde PostgreSQL,
    las envía a InfluxDB y luego las borra de PostgreSQL.
    """
    logger.info(f"[Resend Thread {device_id}] Iniciando.")
    local_db_conn = None
    try:
        local_db_conn = psycopg2.connect(DB_CONN_STRING)
        
        points_to_resend = []
        ids_to_delete = []

        with local_db_conn.cursor() as cursor:
            cursor.execute(
                "SELECT id, payload_json FROM mediciones_pendientes WHERE device_id = %s ORDER BY ts_unix", 
                (device_id,)
            )
            rows = cursor.fetchall()
        
        if not rows:
            logger.info(f"[Resend Thread {device_id}] No hay datos pendientes para reenviar.")
            return

        logger.info(f"[Resend Thread {device_id}] Procesando {len(rows)} mediciones pendientes...")

        for row in rows:
            id_db, payload_str = row
            point, _ = parse_payload_to_point(payload_str, device_id)
            if point:
                points_to_resend.append(point)
                ids_to_delete.append(id_db)
            else:
                logger.warning(f"[Resend Thread {device_id}] Omitiendo punto inválido ID: {id_db}")

        if not points_to_resend:
            logger.info(f"[Resend Thread {device_id}] No hay puntos válidos para reenviar.")
            return

        logger.info(f"[Resend Thread {device_id}] Enviando {len(points_to_resend)} puntos a InfluxDB...")
        # NOTA: Este reenvío es "todo o nada". Si falla, se reintentará
        # la próxima vez que el cliente pase de 'gracia' a 'activo'.
        # Para producción más robusta, se podría implementar batching aquí también.
        influx_write_api.write(
            bucket=INFLUX_BUCKET_NEW, 
            org=INFLUX_ORG, 
            record=points_to_resend
        )
        logger.info(f"[Resend Thread {device_id}] ✅ Reenvío a InfluxDB exitoso.")

        with local_db_conn.cursor() as cursor:
            execute_values(
                cursor, 
                "DELETE FROM mediciones_pendientes WHERE id IN %s", 
                [(id,) for id in ids_to_delete]
            )
        local_db_conn.commit()
        logger.info(f"[Resend Thread {device_id}] ✅ {len(ids_to_delete)} registros borrados del búfer local.")

    except Exception:
        logger.exception(f"❌ ERROR CRÍTICO en [Resend Thread {device_id}]")
        if local_db_conn:
            local_db_conn.rollback() # Revertir borrado si Influx falló
    finally:
        if local_db_conn:
            local_db_conn.close()
            logger.info(f"[Resend Thread {device_id}] Conexión de BD local cerrada.")

def delete_local_buffer(device_id):
    """
    [EJECUTADO EN UN THREAD]
    Borra TODAS las mediciones pendientes para un device_id.
    """
    logger.info(f"[Purge Thread {device_id}] Iniciando purga.")
    local_db_conn = None
    try:
        local_db_conn = psycopg2.connect(DB_CONN_STRING)
        local_db_conn.autocommit = True
        
        with local_db_conn.cursor() as cursor:
            cursor.execute(
                "DELETE FROM mediciones_pendientes WHERE device_id = %s", 
                (device_id,)
            )
            count = cursor.rowcount
        
        logger.info(f"[Purge Thread {device_id}] ✅ Purga completada. {count} registros eliminados.")

    except Exception:
        logger.exception(f"❌ ERROR CRÍTICO en [Purge Thread {device_id}]")
    finally:
        if local_db_conn:
            local_db_conn.close()


# --- 8. Lógica de Conexión MQTT ---

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


# --- 9. Thread de Flush Periódico ---

def periodic_flush_thread():
    """Thread que fuerza el flush del buffer de Influx periódicamente."""
    while True:
        time_since_last_flush = time.time() - last_flush_time
        
        if (time_since_last_flush > BATCH_TIMEOUT / 2):
            time.sleep(1) 
            check_and_flush_buffer()
        else:
            time.sleep(BATCH_TIMEOUT / 2)

# --- 10. Ejecución Principal ---

def main():
    # --- Configuración del Logging ---
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(name)s - %(message)s',
        stream=sys.stdout
    )

    logger.info("=" * 60)
    logger.info("INICIANDO RECEPTOR LETE - v5 (LÓGICA ANTI-BLOQUEO)")
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
    logger.info("✅ Thread de flush periódico (Influx) iniciado")

    # 4. Configurar cliente MQTT
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION1, 
        client_id="receptor_servidor_lete_v5" # Nuevo Client ID
    )
    
    if MQTT_USERNAME and MQTT_PASSWORD:
        client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message

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
    logger.info(f"📊 Batching (Influx): {BATCH_SIZE} mediciones o {BATCH_TIMEOUT}s")
    logger.info(f"💡 Lógica de Suscripción: TTL de caché de {CACHE_TTL_SECONDS}s, Gracia de {GRACE_PERIOD_DAYS} días.")
    logger.info(f"☣️ Protección Anti-Bloqueo (Poison Pill) ACTIVADA.")
    logger.info("=" * 60 + "\n")
    
    try:
        client.loop_forever()
    except KeyboardInterrupt:
        logger.info("\n\n🛑 Detectado (Ctrl+C). Cerrando sistema...")
        logger.info("📤 Enviando últimas mediciones pendientes (Influx)...")
        flush_buffer_to_influx()
    except Exception:
        logger.exception("❌ ERROR CRÍTICO INESPERADO EN EL BUCLE PRINCIPAL")
    finally:
        if db_conn and not db_conn.closed:
            db_conn.close()
            logger.info("🔌 Conexión principal con PostgreSQL cerrada.")
        if influx_client:
            influx_client.close()
            logger.info("🔌 Conexión con InfluxDB cerrada.")
        client.disconnect()
        logger.info("🔌 Desconectado de MQTT.")
        logger.info("\n✅ Sistema detenido correctamente.\n")

if __name__ == "__main__":
    main()