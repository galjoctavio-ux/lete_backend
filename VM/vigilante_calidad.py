# -------------------------------------------------------------------
# Script Vigilante de Calidad de Energía v2.3 (Detección Estadística)
# - Implementa detección de anomalías con media y varianza móvil (EWMA).
# - Utiliza una columna JSONB en la BD para almacenar estadísticas.
# - Agrupa el día en 5 bloques de comportamiento para mayor precisión.
# - Requiere 2 "strikes" consecutivos para enviar una alerta de anomalía.
# - MODIFICADO: Incluye chequeo de primera medición para enviar felicitación.
# -------------------------------------------------------------------

# --- 1. Importaciones ---
import psycopg2
import psycopg2.extras
import requests
import pandas as pd
import os
import json
from datetime import date, datetime, timedelta
from dotenv import load_dotenv
import pytz
from tenacity import retry, stop_after_attempt, wait_exponential
import calendar
import math
from influxdb_client import InfluxDBClient

# --- 2. Carga de Variables de Entorno ---
load_dotenv()

# --- 3. Configuración General ---
ENVIAR_WHATSAPP = True

DB_HOST = os.environ.get("DB_HOST")
DB_USER = os.environ.get("DB_USER")
DB_PASS = os.environ.get("DB_PASS")
DB_NAME = os.environ.get("DB_NAME")

TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN")
TWILIO_FROM_NUMBER = os.environ.get("TWILIO_FROM_NUMBER")
TWILIO_URL = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json"
ADMIN_WHATSAPP_NUMBER = os.environ.get("ADMIN_WHATSAPP_NUMBER")
INFLUX_URL = os.environ.get("INFLUX_URL")
INFLUX_TOKEN = os.environ.get("INFLUX_TOKEN")
INFLUX_ORG = os.environ.get("INFLUX_ORG")
INFLUX_BUCKET = os.environ.get("INFLUX_BUCKET_NEW")

TPL_PICOS_VOLTAJE = os.environ.get("TPL_PICOS_VOLTAJE")
TPL_BAJO_VOLTAJE = os.environ.get("TPL_BAJO_VOLTAJE")
TPL_FUGA_CORRIENTE = os.environ.get("TPL_FUGA_CORRIENTE")
TPL_BRINCO_ESCALON = os.environ.get("TPL_BRINCO_ESCALON")
TPL_CONSUMO_FANTASMA = os.environ.get("TPL_CONSUMO_FANTASMA")
TPL_DISPOSITIVO_OFFLINE = os.environ.get("TPL_DISPOSITIVO_OFFLINE")

# --- ¡NUEVA VARIABLE REQUERIDA! ---
# Añade esta variable a tu archivo .env con el SID de la plantilla de Twilio
TPL_FELICITACION_CONEXION = os.environ.get("TPL_FELICITACION_CONEXION")

# Lógica de Negocio y Reglas
ZONA_HORARIA_LOCAL = pytz.timezone('America/Mexico_City')
UMBRAL_VOLTAJE_ALTO = 139.7
UMBRAL_VOLTAJE_BAJO = 114.3
CANTIDAD_EVENTOS_VOLTAJE_PARA_ALERTA = 3
UMBRAL_FUGA_CORRIENTE = 0.5

# Configuración para Detección de Anomalías
NUM_STRIKES_PARA_ALERTA = 2
DESVIACIONES_ESTANDAR_PARA_ANOMALIA = 2.0
PERIODO_APRENDIZAJE_MUESTRAS = 20

TARIFAS_CFE_UMBRALES = {
    '01':  [{'limite': 150, 'precio_siguiente': 1.32, 'bandera': 'escalon1'}, {'limite': 280, 'precio_siguiente': 3.85, 'bandera': 'escalon2'}],
    '01A': [{'limite': 200, 'precio_siguiente': 1.32, 'bandera': 'escalon1'}, {'limite': 400, 'precio_siguiente': 3.85, 'bandera': 'escalon2'}]
}

# --- 4. Funciones ---

def obtener_clientes(conn):
    """Obtiene una lista de clientes, incluyendo estadísticas y datos del dispositivo."""
    try:
        cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
        
        cursor.execute("""
            SELECT 
                d.device_id, 
                c.telefono_whatsapp, c.nombre, c.dia_de_corte, c.tipo_tarifa, c.ciclo_bimestral,
                c.notificacion_escalon1_enviada, c.notificacion_escalon2_enviada,
                c.estadisticas_consumo,
                c.lectura_medidor_inicial,  
                c.fecha_inicio_servicio,    
                c.lectura_cierre_periodo_anterior,
                c.primera_medicion_recibida       -- <-- ¡NUEVO CAMPO!
            FROM clientes c
            JOIN dispositivos_lete d ON c.id = d.cliente_id
            WHERE c.subscription_status = 'active'
        """)
        lista_clientes = cursor.fetchall()
        cursor.close()
        print(f"✅ Se encontraron {len(lista_clientes)} clientes activos en la base de datos.")
        return lista_clientes
    except Exception as e:
        print(f"❌ ERROR al obtener clientes: {e}")
        return []

@retry(wait=wait_exponential(multiplier=1, min=4, max=10), stop=stop_after_attempt(3))
def enviar_alerta_whatsapp(telefono_destino, content_sid, content_variables):
    """Envía un mensaje de WhatsApp o lo simula en pantalla según el interruptor."""
    if not ENVIAR_WHATSAPP:
        print("\n--- SIMULACIÓN DE ALERTA WHATSAPP (Envío desactivado) ---")
        print(f"    -> Destinatario: {telefono_destino}")
        print(f"    -> Plantilla (SID): {content_sid}")
        print(f"    -> Variables: {json.dumps(content_variables)}")
        print("---------------------------------------------------------")
        return

    if not telefono_destino or not content_sid:
        print(f"⚠️  Teléfono ({telefono_destino}) o Content SID ({content_sid}) vacío. No se envía alerta.")
        return
    payload = {
        "ContentSid": content_sid,
        "ContentVariables": json.dumps(content_variables),
        "From": TWILIO_FROM_NUMBER,
        "To": f"whatsapp:{telefono_destino}"
    }
    print(f"\nEnviando WhatsApp (Plantilla {content_sid}) a: {telefono_destino}...")
    response = requests.post(TWILIO_URL, auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN), data=payload)
    if response.status_code == 201:
        print(f"✔️ Alerta enviada exitosamente.")
    else:
        print(f"⚠️  Error al enviar alerta. Código: {response.status_code}, Respuesta: {response.text}")
        response.raise_for_status()

def marcar_notificacion_enviada(conn, device_id, tipo_bandera):
    """Actualiza una bandera de notificación en la base de datos."""
    banderas_permitidas = ['notificacion_escalon1_enviada', 'notificacion_escalon2_enviada']
    if tipo_bandera not in banderas_permitidas:
        print(f"⚠️ Intento de actualizar bandera no permitida: {tipo_bandera}")
        return
    print(f"Actualizando bandera '{tipo_bandera}' para {device_id}...")
    try:
        cursor = conn.cursor()
        # --- ¡CONSULTA MODIFICADA CON UPDATE...FROM...WHERE! ---
        sql = f"""
            UPDATE clientes c
            SET {tipo_bandera} = true
            FROM dispositivos_lete d
            WHERE c.id = d.cliente_id AND d.device_id = %s
        """
        cursor.execute(sql, (device_id,))
        conn.commit()
        cursor.close()
    except Exception as e:
        print(f"❌ ERROR al actualizar bandera de notificación para {device_id}: {e}")

def actualizar_estadisticas(conn, device_id, estadisticas_actuales):
    """Actualiza la columna JSONB de estadísticas para un cliente."""
    print(f"Actualizando estadísticas para {device_id}...")
    try:
        cursor = conn.cursor()
        # --- ¡CONSULTA MODIFICADA CON UPDATE...FROM...WHERE! ---
        sql = """
            UPDATE clientes c
            SET estadisticas_consumo = %s
            FROM dispositivos_lete d
            WHERE c.id = d.cliente_id AND d.device_id = %s
        """
        cursor.execute(sql, (json.dumps(estadisticas_actuales), device_id))
        conn.commit()
        cursor.close()
    except Exception as e:
        print(f"❌ ERROR al actualizar estadísticas para {device_id}: {e}")

def get_bloque_horario(hora):
    """Devuelve el nombre del bloque horario según la hora del día."""
    if 0 <= hora < 6: return "madrugada"
    if 6 <= hora < 9: return "manana"
    if 9 <= hora < 18: return "dia_laboral"
    if 18 <= hora < 21: return "tarde"
    return "noche" # 21 a 23

def calcular_fechas_corte(hoy_aware, dia_de_corte, ciclo_bimestral):
    """Calcula la fecha de corte más reciente (el inicio del periodo actual)."""
    hoy = hoy_aware.date()
    candidatos_pasados = []
    for i in range(12):
        mes_candidato = hoy.month - i
        ano_candidato = hoy.year
        if mes_candidato <= 0:
            mes_candidato += 12
            ano_candidato -= 1
        es_mes_par = (mes_candidato % 2 == 0)
        if (ciclo_bimestral == 'par' and es_mes_par) or (ciclo_bimestral == 'impar' and not es_mes_par):
            try:
                dia = min(dia_de_corte, calendar.monthrange(ano_candidato, mes_candidato)[1])
                fecha_candidata = date(ano_candidato, mes_candidato, dia)
                if fecha_candidata <= hoy:
                    candidatos_pasados.append(fecha_candidata)
            except ValueError: continue
    return max(candidatos_pasados) if candidatos_pasados else None

def obtener_consumo_desde_influxdb(device_id, fecha_inicio_aware, fecha_fin_aware):
    """
    Obtiene el consumo total de un dispositivo (en kWh) desde InfluxDB 
    para un rango de tiempo específico.
    """
    start_time = fecha_inicio_aware.isoformat()
    stop_time = fecha_fin_aware.isoformat()

    flux_query = f"""
    from(bucket: "{INFLUX_BUCKET}")
      |> range(start: {start_time}, stop: {stop_time})
      |> filter(fn: (r) => r._measurement == "energia")
      |> filter(fn: (r) => r._field == "power")
      |> filter(fn: (r) => r.device_id == "{device_id}")
      |> integral(unit: 1s)
      |> map(fn: (r) => ({{ _value: r._value / 3600000.0 }}))
      |> sum()
    """
    try:
        with InfluxDBClient(url=INFLUX_URL, token=INFLUX_TOKEN, org=INFLUX_ORG, timeout=10_000) as client:
            query_api = client.query_api()
            tables = query_api.query(query=flux_query)
            if tables and tables[0].records:
                total_kwh = tables[0].records[0].get_value()
                return total_kwh, None
            else:
                return None, None
    except Exception as e:
        print(f"❌ ERROR al consultar InfluxDB (kwh) para {device_id}: {e}")
        return None, None

def obtener_datos_influx_dataframe(device_id, minutos_atras):
    """Obtiene un DataFrame de Pandas con los datos de InfluxDB de los últimos X minutos."""

    ahora = datetime.now(ZONA_HORARIA_LOCAL)
    tiempo_limite = ahora - timedelta(minutes=minutos_atras)
    start_time = tiempo_limite.isoformat()

    flux_query = f"""
    from(bucket: "{INFLUX_BUCKET}")
      |> range(start: {start_time})
      |> filter(fn: (r) => r._measurement == "energia")
      |> filter(fn: (r) => r.device_id == "{device_id}")
      |> filter(fn: (r) => r._field == "vrms" or r._field == "leakage" or r._field == "power")
      |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
      |> keep(columns: ["_time", "vrms", "leakage", "power"])
    """

    try:
        with InfluxDBClient(url=INFLUX_URL, token=INFLUX_TOKEN, org=INFLUX_ORG, timeout=10_000) as client:
            df = client.query_api().query_data_frame(query=flux_query)

            if df.empty:
                return None

            df = df.rename(columns={"_time": "timestamp_servidor"})
            df['timestamp_servidor'] = df['timestamp_servidor'].dt.tz_convert(ZONA_HORARIA_LOCAL)
            return df

    except Exception as e:
        print(f"❌ ERROR al consultar InfluxDB (DataFrame) para {device_id}: {e}")
        return None

# --- Funciones de Verificación de Alertas ---

# --- ¡NUEVA FUNCIÓN! ---
def verificar_primera_medicion(conn, cliente):
    """Verifica si es la primera medición y envía felicitación."""
    if cliente['primera_medicion_recibida']:
        return False # Ya se procesó, no hacer nada.
    
    print(f"-> {cliente['nombre']}: Verificando primera medición...")
    
    # Consultamos InfluxDB. Si hay CUALQUIER dato reciente, es la primera vez.
    # Usamos 60 minutos para coincidir con la frecuencia del script
    df_check = obtener_datos_influx_dataframe(cliente['device_id'], 60) 
    
    if df_check is not None and not df_check.empty:
        print(f"🎉 ¡PRIMERA MEDICIÓN RECIBIDA para {cliente['nombre']}!")
        
        # 1. Enviar felicitación
        if not TPL_FELICITACION_CONEXION:
            print("⚠️ ⚠️  ADVERTENCIA: TPL_FELICITACION_CONEXION no está configurado en .env. No se puede enviar felicitación.")
        else:
            variables = {"1": cliente['nombre']}
            enviar_alerta_whatsapp(cliente['telefono_whatsapp'], TPL_FELICITACION_CONEXION, variables)
        
        # 2. Actualizar la bandera en la BD
        try:
            cursor = conn.cursor()
            sql = """
                UPDATE clientes c
                SET primera_medicion_recibida = true
                FROM dispositivos_lete d
                WHERE c.id = d.cliente_id AND d.device_id = %s
            """
            cursor.execute(sql, (cliente['device_id'],))
            conn.commit()
            cursor.close()
        except Exception as e:
            print(f"❌ ERROR al actualizar 'primera_medicion_recibida' para {cliente['device_id']}: {e}")
        
        return True # Sí, fue la primera medición.
    else:
        print(f" -> {cliente['nombre']}: Aún sin mediciones.")
        return False

# --- ¡FUNCIÓN MODIFICADA! ---
def verificar_dispositivo_offline(df, cliente):
    # --- ¡NUEVA GUARDIA! ---
    if not cliente['primera_medicion_recibida']:
        print("-> Dispositivo aún no reporta su primera medición. Omitiendo chequeo offline.")
        return
    # --- FIN DE GUARDIA ---

    print("-> Verificando estado de conexión...")
    if df is None:
        enviar_alerta_whatsapp(ADMIN_WHATSAPP_NUMBER, TPL_DISPOSITIVO_OFFLINE, {"1": cliente['nombre']})
        return

    ultima_medicion = df['timestamp_servidor'].max()
    minutos_desde_ultima_medicion = (datetime.now(ZONA_HORARIA_LOCAL) - ultima_medicion).total_seconds() / 60
    
    if minutos_desde_ultima_medicion > 25:
        enviar_alerta_whatsapp(ADMIN_WHATSAPP_NUMBER, TPL_DISPOSITIVO_OFFLINE, {"1": cliente['nombre']})
        
def verificar_voltaje(df, cliente):
    if df is None: return
    print("-> Verificando voltaje...")
    
    picos_altos = df[df['vrms'] > UMBRAL_VOLTAJE_ALTO].shape[0]
    if picos_altos >= CANTIDAD_EVENTOS_VOLTAJE_PARA_ALERTA:
        variables = {"1": cliente['nombre'], "2": str(picos_altos)}
        enviar_alerta_whatsapp(cliente['telefono_whatsapp'], TPL_PICOS_VOLTAJE, variables)

    picos_bajos = df[df['vrms'] < UMBRAL_VOLTAJE_BAJO].shape[0]
    if picos_bajos >= CANTIDAD_EVENTOS_VOLTAJE_PARA_ALERTA:
        variables = {"1": cliente['nombre']}
        enviar_alerta_whatsapp(cliente['telefono_whatsapp'], TPL_BAJO_VOLTAJE, variables)

def verificar_fuga_corriente(df, cliente):
    if df is None: return
    print("-> Verificando fuga de corriente...")
    
    fuga_promedio = df['leakage'].mean()
    if fuga_promedio > UMBRAL_FUGA_CORRIENTE:
        variables = {"1": cliente['nombre']}
        enviar_alerta_whatsapp(cliente['telefono_whatsapp'], TPL_FUGA_CORRIENTE, variables)

def verificar_anomalia_consumo(conn, df, cliente):
    """Compara el consumo actual con el perfil estadístico del cliente."""
    if df is None: return
    print("-> Verificando anomalías de consumo...")

    ahora = datetime.now(ZONA_HORARIA_LOCAL)
    bloque_actual = get_bloque_horario(ahora.hour)
    consumo_actual = df['power'].mean()

    estadisticas = cliente['estadisticas_consumo'] if cliente['estadisticas_consumo'] is not None else {}
    
    stats_bloque = estadisticas.get(bloque_actual, {
        'media': consumo_actual,
        'varianza': (consumo_actual * 0.3)**2,
        'n_muestras': 0,
        'strikes': 0
    })

    media = stats_bloque['media']
    varianza = stats_bloque['varianza']
    desv_std = math.sqrt(varianza) if varianza > 0 else 0
    limite_superior = media + (DESVIACIONES_ESTANDAR_PARA_ANOMALIA * desv_std)
    
    es_anomalia = False
    if stats_bloque['n_muestras'] < PERIODO_APRENDIZAJE_MUESTRAS:
        print(f"    -> En periodo de aprendizaje para '{bloque_actual}' ({stats_bloque['n_muestras'] + 1} muestras).")
        α = 0.2
        if consumo_actual > (media * 3): # Alerta solo para anomalías extremas
            es_anomalia = True
    else:
        α = 0.1
        if consumo_actual > limite_superior:
            es_anomalia = True
            
    if es_anomalia:
        stats_bloque['strikes'] += 1
        print(f"    -> ¡ANOMALÍA! Consumo: {consumo_actual:.0f}W, Límite: {limite_superior:.0f}W. Strike #{stats_bloque['strikes']}.")
        if stats_bloque['strikes'] >= NUM_STRIKES_PARA_ALERTA:
            porcentaje = ((consumo_actual / media - 1) * 100) if media > 0 else 0
            hora_legible = ahora.strftime('%I:%M %p')
            variables = {"1": cliente['nombre'], "2": hora_legible, "3": f"{porcentaje:.0f}"}
            enviar_alerta_whatsapp(cliente['telefono_whatsapp'], TPL_CONSUMO_FANTASMA, variables)
            stats_bloque['strikes'] = 0
    else:
        stats_bloque['strikes'] = 0

    media_nueva = α * consumo_actual + (1 - α) * stats_bloque['media']
    diferencia = consumo_actual - media_nueva
    varianza_nueva = α * (diferencia ** 2) + (1 - α) * stats_bloque['varianza']
    
    stats_bloque['media'] = media_nueva
    stats_bloque['varianza'] = varianza_nueva
    stats_bloque['n_muestras'] += 1
    
    # Resetea strikes de otros bloques para no arrastrarlos
    for bloque in estadisticas:
        if bloque != bloque_actual:
            estadisticas[bloque]['strikes'] = 0
            
    estadisticas[bloque_actual] = stats_bloque
    actualizar_estadisticas(conn, cliente['device_id'], estadisticas)
        
def verificar_brinco_escalon(conn, cliente):
    """Verifica si el cliente ha cruzado a un nuevo escalón de tarifa CFE, usando datos iniciales."""
    print("-> Verificando brinco de escalón de tarifa...")
    if cliente['tipo_tarifa'] not in TARIFAS_CFE_UMBRALES: return

    ultima_corte = calcular_fechas_corte(datetime.now(ZONA_HORARIA_LOCAL), cliente['dia_de_corte'], cliente['ciclo_bimestral'])
    if not ultima_corte: 
        print("    -> No se pudo calcular la última fecha de corte. Omitiendo brinco de escalón.")
        return

    # Variables
    device_id = cliente['device_id']
    fecha_inicio_servicio = cliente.get('fecha_inicio_servicio') # Esto es un datetime.datetime
    lectura_cierre = cliente.get('lectura_cierre_periodo_anterior')
    lectura_inicial = cliente.get('lectura_medidor_inicial')

    # 1. Determinar el rango de medición en InfluxDB
    
    # Por defecto, la medición inicia en el último corte (que es un objeto 'date')
    fecha_inicio_medicion = ultima_corte
    
    # --- INICIO DE LA CORRECCIÓN ---
    # Comparamos 'date' con 'date'
    if fecha_inicio_servicio and fecha_inicio_servicio.date() > ultima_corte:
        # Si la instalación fue después, usamos la fecha de instalación (como 'date')
        fecha_inicio_medicion = fecha_inicio_servicio.date() 
    # --- FIN DE LA CORRECCIÓN ---
    
    # 2. Consultar el consumo medido por InfluxDB
    # 'fecha_inicio_medicion' es ahora un objeto 'date' garantizado
    inicio_periodo_aware = ZONA_HORARIA_LOCAL.localize(datetime.combine(fecha_inicio_medicion, datetime.min.time()))
    fin_periodo_aware = datetime.now(ZONA_HORARIA_LOCAL)
    
    kwh_medidos_influx, _ = obtener_consumo_desde_influxdb(device_id, inicio_periodo_aware, fin_periodo_aware)
    if kwh_medidos_influx is None: kwh_medidos_influx = 0.0

    # 3. Aplicar la lógica del "Primer Periodo" (Solo si hay datos de lectura inicial)
    
    # --- INICIO DE LA CORRECCIÓN ---
    # Comparamos 'date' con 'date'
    if (lectura_inicial is not None and 
        lectura_cierre is not None and 
        fecha_inicio_servicio and 
        fecha_inicio_servicio.date() > ultima_corte):
    # --- FIN DE LA CORRECCIÓN ---
        
        # El cliente está en su primer periodo Y se instaló después del corte.
        
        # kWh acumulados por CFE ANTES de la instalación
        consumo_acarreado = float(lectura_inicial) - float(lectura_cierre)
        
        # Consumo total real del periodo = Acarreado + Medido por LETE
        kwh_acumulados = consumo_acarreado + kwh_medidos_influx
        
        print(f"    -> Lógica de Primer Periodo aplicada.")
        print(f"    -> Consumo acarreado (desde corte hasta instalación): {consumo_acarreado:.2f} kWh")
        print(f"    -> Consumo medido por LETE: {kwh_medidos_influx:.2f} kWh")
    
    else:
        # Lógica de "Periodo Normal" (Segundo periodo en adelante o si se instaló justo en el corte)
        # Aquí el consumo es simplemente lo que hemos medido desde el inicio del periodo.
        kwh_acumulados = kwh_medidos_influx
        print("    -> Lógica de Periodo Normal aplicada.")

    print(f"    -> Total Acumulado para escalón: {kwh_acumulados:.2f} kWh")

    # 4. Verificar contra umbrales (Esta parte NO cambia)
    for umbral in TARIFAS_CFE_UMBRALES[cliente['tipo_tarifa']]:
        bandera_notificacion = f"notificacion_{umbral['bandera']}_enviada"
        if kwh_acumulados > umbral['limite'] and not cliente[bandera_notificacion]:
            variables = {"1": cliente['nombre'], "2": f"{umbral['precio_siguiente']:.2f}"}
            enviar_alerta_whatsapp(cliente['telefono_whatsapp'], TPL_BRINCO_ESCALON, variables)
            marcar_notificacion_enviada(conn, device_id, bandera_notificacion)
            break    
                
# --- 5. EJECUCIÓN PRINCIPAL (CORREGIDA Y MODIFICADA) ---
def main():
    print("=" * 50)
    print(f"--- Iniciando VIGILANTE v2.3 ({datetime.now(ZONA_HORARIA_LOCAL).strftime('%Y-%m-%d %H:%M:%S')}) ---")

    conn = None
    try:
        # --- INICIO DE LA CORRECCIÓN ---
        # Ambas líneas deben estar indentadas para pertenecer al bloque 'try'
        DB_PORT = os.environ.get("DB_PORT", "5432")
        conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, user=DB_USER, password=DB_PASS, dbname=DB_NAME)
        # --- FIN DE LA CORRECCIÓN ---
        print("✅ Conexión con Base de Datos exitosa.")
    except Exception as e:
        print(f"❌ ERROR de conexión con la Base de Datos. Abortando. Detalles: {e}")
        return

    clientes = obtener_clientes(conn)
    if not clientes:
        print("No hay clientes para procesar. Terminando script.")
        if conn: conn.close()
        return

    for cliente in clientes:
        print(f"\n--- Verificando alertas para: {cliente['nombre']} ({cliente['device_id']}) ---")

        # --- ¡NUEVA LÓGICA DE PRIMERA MEDICIÓN! ---
        fue_la_primera_medicion = verificar_primera_medicion(conn, cliente)
        if fue_la_primera_medicion:
            continue # Saltar el resto de chequeos en esta primera ejecución
        # --- FIN DE LÓGICA ---

        df_ultima_hora = obtener_datos_influx_dataframe(cliente['device_id'], 60)

        verificar_dispositivo_offline(df_ultima_hora, cliente)
        verificar_voltaje(df_ultima_hora, cliente)
        verificar_fuga_corriente(df_ultima_hora, cliente)
        verificar_anomalia_consumo(conn, df_ultima_hora, cliente)
        verificar_brinco_escalon(conn, cliente)

    if conn:
        conn.close()
        print("\n🔌 Conexión con Base de Datos cerrada.")

    print("\n--- VIGILANTE v2.3 completado. ---")
    print("=" * 50)

if __name__ == "__main__":
    main()