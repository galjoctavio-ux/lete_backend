# -------------------------------------------------------------------
# Script Vigilante de Calidad de Energía v2.3 (Detección Estadística)
# - Implementa detección de anomalías con media y varianza móvil (EWMA).
# - Utiliza una columna JSONB en la BD para almacenar estadísticas.
# - Agrupa el día en 5 bloques de comportamiento para mayor precisión.
# - Requiere 2 "strikes" consecutivos para enviar una alerta de anomalía.
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

# --- 2. Carga de Variables de Entorno ---
load_dotenv()

# --- 3. Configuración General ---
ENVIAR_WHATSAPP = False

DB_HOST = os.environ.get("DB_HOST")
DB_USER = os.environ.get("DB_USER")
DB_PASS = os.environ.get("DB_PASS")
DB_NAME = os.environ.get("DB_NAME")

TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN")
TWILIO_FROM_NUMBER = os.environ.get("TWILIO_FROM_NUMBER")
TWILIO_URL = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json"
ADMIN_WHATSAPP_NUMBER = os.environ.get("ADMIN_WHATSAPP_NUMBER")

TPL_PICOS_VOLTAJE = os.environ.get("TPL_PICOS_VOLTAJE")
TPL_BAJO_VOLTAJE = os.environ.get("TPL_BAJO_VOLTAJE")
TPL_FUGA_CORRIENTE = os.environ.get("TPL_FUGA_CORRIENTE")
TPL_BRINCO_ESCALON = os.environ.get("TPL_BRINCO_ESCALON")
TPL_CONSUMO_FANTASMA = os.environ.get("TPL_CONSUMO_FANTASMA")
TPL_DISPOSITIVO_OFFLINE = os.environ.get("TPL_DISPOSITIVO_OFFLINE")

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
    """Obtiene una lista de clientes, incluyendo la nueva columna de estadísticas."""
    try:
        cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
        cursor.execute("""
            SELECT device_id, telefono_whatsapp, nombre, dia_de_corte, tipo_tarifa, ciclo_bimestral,
                   notificacion_escalon1_enviada, notificacion_escalon2_enviada,
                   estadisticas_consumo
            FROM clientes
        """)
        lista_clientes = cursor.fetchall()
        cursor.close()
        print(f"✅ Se encontraron {len(lista_clientes)} clientes en la base de datos.")
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
        sql = f"UPDATE clientes SET {tipo_bandera} = true WHERE device_id = %s"
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
        sql = "UPDATE clientes SET estadisticas_consumo = %s WHERE device_id = %s"
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

def obtener_consumo_desde_servidor_local(device_id, fecha_inicio_aware, fecha_fin_aware):
    """Lee el archivo CSV local, filtra los datos y calcula el consumo en kWh."""
    archivo_csv = 'mediciones.csv'
    try:
        df = pd.read_csv(archivo_csv)
        if df.empty: return None, None
        if 'timestamp_servidor' not in df.columns: return None, None
        df['timestamp_servidor'] = pd.to_datetime(df['timestamp_servidor'])
        if df['timestamp_servidor'].dt.tz is None:
            df['timestamp_servidor'] = df['timestamp_servidor'].dt.tz_localize(ZONA_HORARIA_LOCAL, ambiguous='infer')
        else:
            df['timestamp_servidor'] = df['timestamp_servidor'].dt.tz_convert(ZONA_HORARIA_LOCAL)
        df_filtrado = df[(df['device_id'] == device_id) & (df['timestamp_servidor'] >= fecha_inicio_aware) & (df['timestamp_servidor'] < fecha_fin_aware)]
        if df_filtrado.empty: return None, None
        df_calculo = df_filtrado.set_index('timestamp_servidor').sort_index()
        potencia_media_W = df_calculo['power'].resample('1min').mean()
        potencia_interpolada = potencia_media_W.interpolate(method='linear', limit=60)
        kwh_intervalo = (potencia_interpolada / 1000) * (1 / 60.0)
        kwh_intervalo = kwh_intervalo.fillna(0)
        total_kwh = kwh_intervalo.sum()
        return total_kwh, None
    except Exception: return None, None

def obtener_datos_locales(device_id, minutos_atras):
    """Obtiene un DataFrame de Pandas con los datos de un dispositivo de los últimos X minutos."""
    archivo_csv = 'mediciones.csv'
    try:
        df = pd.read_csv(archivo_csv, parse_dates=['timestamp_servidor'])
        if df.empty: return None

        ahora = datetime.now(ZONA_HORARIA_LOCAL)
        tiempo_limite = ahora - timedelta(minutes=minutos_atras)
        
        if df['timestamp_servidor'].dt.tz is None:
            df['timestamp_servidor'] = df['timestamp_servidor'].dt.tz_localize(ZONA_HORARIA_LOCAL, ambiguous='infer')
        else:
            df['timestamp_servidor'] = df['timestamp_servidor'].dt.tz_convert(ZONA_HORARIA_LOCAL)

        df_filtrado = df[(df['device_id'] == device_id) & (df['timestamp_servidor'] >= tiempo_limite)].copy()
        
        return df_filtrado if not df_filtrado.empty else None
    except FileNotFoundError: return None
    except Exception: return None

# --- Funciones de Verificación de Alertas ---

def verificar_dispositivo_offline(df, cliente):
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
        print(f"   -> En periodo de aprendizaje para '{bloque_actual}' ({stats_bloque['n_muestras'] + 1} muestras).")
        α = 0.2
        if consumo_actual > (media * 3): # Alerta solo para anomalías extremas
            es_anomalia = True
    else:
        α = 0.1
        if consumo_actual > limite_superior:
            es_anomalia = True
            
    if es_anomalia:
        stats_bloque['strikes'] += 1
        print(f"   -> ¡ANOMALÍA! Consumo: {consumo_actual:.0f}W, Límite: {limite_superior:.0f}W. Strike #{stats_bloque['strikes']}.")
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
    print("-> Verificando brinco de escalón de tarifa...")
    if cliente['tipo_tarifa'] not in TARIFAS_CFE_UMBRALES: return

    ultima_corte = calcular_fechas_corte(datetime.now(ZONA_HORARIA_LOCAL), cliente['dia_de_corte'], cliente['ciclo_bimestral'])
    if not ultima_corte: return

    inicio_periodo = ZONA_HORARIA_LOCAL.localize(datetime.combine(ultima_corte, datetime.min.time()))
    fin_periodo = datetime.now(ZONA_HORARIA_LOCAL)
    
    kwh_acumulados, _ = obtener_consumo_desde_servidor_local(cliente['device_id'], inicio_periodo, fin_periodo)
    if kwh_acumulados is None: return

    for umbral in TARIFAS_CFE_UMBRALES[cliente['tipo_tarifa']]:
        bandera_notificacion = f"notificacion_{umbral['bandera']}_enviada"
        if kwh_acumulados > umbral['limite'] and not cliente[bandera_notificacion]:
            variables = {"1": cliente['nombre'], "2": f"{umbral['precio_siguiente']:.2f}"}
            enviar_alerta_whatsapp(cliente['telefono_whatsapp'], TPL_BRINCO_ESCALON, variables)
            marcar_notificacion_enviada(conn, cliente['device_id'], bandera_notificacion)
            break
            
# --- 5. EJECUCIÓN PRINCIPAL ---
def main():
    print("=" * 50)
    print(f"--- Iniciando VIGILANTE v2.3 ({datetime.now(ZONA_HORARIA_LOCAL).strftime('%Y-%m-%d %H:%M:%S')}) ---")
    
    conn = None
    try:
        conn = psycopg2.connect(host=DB_HOST, user=DB_USER, password=DB_PASS, dbname=DB_NAME)
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
        
        df_ultima_hora = obtener_datos_locales(cliente['device_id'], 60)
        
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