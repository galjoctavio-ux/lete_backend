# -------------------------------------------------------------------
# Script de Alertas Diarias para LETE v3.0 (Reformulado)
# Incorpora mejoras de robustez, precisión y nuevas funcionalidades
# -------------------------------------------------------------------

# --- 1. Importaciones ---
import psycopg2
from influxdb_client_3 import InfluxDBClient3
import requests
import pandas as pd
import certifi
import os
import json
from datetime import date, datetime, timedelta
from dotenv import load_dotenv

# --- MEJORA: Librerías para Zonas Horarias y Reintentos ---
import pytz
from tenacity import retry, stop_after_attempt, wait_exponential

# --- 2. Carga de Variables de Entorno ---
load_dotenv()

# --- 3. Configuración SSL ---
os.environ['GRPC_DEFAULT_SSL_ROOTS_FILE_PATH'] = certifi.where()

# --- 4. Configuración General (desde .env) ---
# --- MEJORA: Se leen todas las configuraciones sensibles y lógicas desde .env ---
INFLUX_URL = os.environ.get("INFLUX_URL")
INFLUX_TOKEN = os.environ.get("INFLUX_TOKEN")
INFLUX_ORG = os.environ.get("INFLUX_ORG")
INFLUX_BUCKET = os.environ.get("INFLUX_BUCKET")

DB_HOST = os.environ.get("DB_HOST")
DB_USER = os.environ.get("DB_USER")
DB_PASS = os.environ.get("DB_PASS")
DB_NAME = os.environ.get("DB_NAME")

TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN")
TWILIO_FROM_NUMBER = os.environ.get("TWILIO_FROM_NUMBER")
TWILIO_URL = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json"

# --- IDs de Plantillas de Mensajes (Templates) ---
CONTENT_SID_REPORTE_DIARIO = os.environ.get("CONTENT_SID_REPORTE_DIARIO") # Renombrado para claridad
CONTENT_SID_AVISO_NUEVO = os.environ.get("CONTENT_SID_AVISO_NUEVO") # Para clientes nuevos

# --- NUEVA FUNCIONALIDAD: IDs para nuevas alertas ---
CONTENT_SID_AVISO_CORTE_3DIAS = os.environ.get("CONTENT_SID_AVISO_CORTE_3DIAS")
CONTENT_SID_AVISO_DIA_DE_CORTE = os.environ.get("CONTENT_SID_AVISO_DIA_DE_CORTE")

# --- Lógica de Negocio y Reglas ---
IVA = 1.16
ZONA_HORARIA_LOCAL = pytz.timezone('America/Mexico_City') # --- MEJORA: Zona horaria explícita ---
MIN_DIAS_PARA_PROYECCION = 5 # --- MEJORA: Mínimo de días para una proyección fiable ---


# --- Estructura de Tarifas CFE (Refactorizada) ---
TARIFAS_CFE = {
    '01': [
        {'hasta_kwh': 150, 'precio': 1.08},
        {'hasta_kwh': 280, 'precio': 1.32},
        {'hasta_kwh': float('inf'), 'precio': 3.85}
    ],
    '01A': [
        {'hasta_kwh': 150, 'precio': 1.08},
        {'hasta_kwh': 300, 'precio': 1.32},
        {'hasta_kwh': float('inf'), 'precio': 3.85}
    ],
    'PDBT': [
        {'hasta_kwh': float('inf'), 'precio': 5.60}
    ]
}

# --- 5. Funciones de Base de Datos ---
# NOTA: Se mantiene la apertura/cierre de conexiones por decisión de posponer la optimización.
def obtener_clientes():
    """Obtiene la lista de clientes y sus datos relevantes de Supabase."""
    try:
        conn = psycopg2.connect(host=DB_HOST, user=DB_USER, password=DB_PASS, dbname=DB_NAME)
        cursor = conn.cursor()
        # --- NUEVA FUNCIONALIDAD: Obtenemos los nuevos campos de notificación ---
        cursor.execute("""
            SELECT device_id, telefono_whatsapp, kwh_promedio_diario, nombre, dia_de_corte, 
                   tipo_tarifa, fecha_inicio_servicio, ciclo_bimestral,
                   notificacion_corte_3dias_enviada, notificacion_dia_corte_enviada
            FROM clientes
        """)
        lista_clientes = cursor.fetchall()
        cursor.close()
        conn.close()
        print(f"✅ Se encontraron {len(lista_clientes)} clientes en la base de datos.")
        return lista_clientes
    except Exception as e:
        print(f"❌ ERROR al conectar con la base de datos de clientes: {e}")
        return []
    
def actualizar_promedio_cliente(device_id, nuevo_promedio):
    """Actualiza el kwh_promedio_diario para un cliente en Supabase."""
    print(f"ACTUALIZANDO promedio para {device_id} a {nuevo_promedio:.2f} kWh/día...")
    try:
        conn = psycopg2.connect(host=DB_HOST, user=DB_USER, password=DB_PASS, dbname=DB_NAME)
        cursor = conn.cursor()
        sql_update_query = "UPDATE clientes SET kwh_promedio_diario = %s WHERE device_id = %s"

        # --- AQUÍ ESTÁ LA CORRECCIÓN ---
        # Se convierte el tipo de dato de NumPy a un float estándar de Python.
        cursor.execute(sql_update_query, (float(nuevo_promedio), device_id))
        
        conn.commit()
        print(f"✅ Promedio para {device_id} actualizado exitosamente.")
    except Exception as e:
        print(f"❌ ERROR al actualizar el promedio para {device_id}: {e}")
    finally:
        # Aseguramos que cursor y conn se cierren incluso si hay error
        if 'cursor' in locals() and not cursor.closed: cursor.close()
        if 'conn' in locals() and not conn.closed: conn.close()

def marcar_notificacion_enviada(device_id, tipo_notificacion):
    """
    --- NUEVA FUNCIONALIDAD: Marca una notificación de corte como enviada para no repetirla. ---
    """
    columna_a_actualizar = f"{tipo_notificacion}_enviada"
    print(f"Marcando bandera '{columna_a_actualizar}' para {device_id}...")
    try:
        conn = psycopg2.connect(host=DB_HOST, user=DB_USER, password=DB_PASS, dbname=DB_NAME)
        cursor = conn.cursor()
        # ¡CUIDADO! Es importante validar tipo_notificacion para evitar inyección SQL.
        if columna_a_actualizar not in ["notificacion_corte_3dias_enviada", "notificacion_dia_corte_enviada"]:
            print(f"⚠️  Intento de actualizar columna no permitida: {columna_a_actualizar}")
            return
        
        sql_update_query = f"UPDATE clientes SET {columna_a_actualizar} = true WHERE device_id = %s"
        cursor.execute(sql_update_query, (device_id,))
        conn.commit()
    except Exception as e:
        print(f"❌ ERROR al actualizar bandera de notificación para {device_id}: {e}")
    finally:
        if 'cursor' in locals(): cursor.close()
        if 'conn' in locals(): conn.close()
        
def resetear_banderas_notificacion(device_id):
    """
    --- NUEVA FUNCIONALIDAD: Resetea las banderas al inicio de un nuevo ciclo. ---
    """
    print(f"Reseteando banderas de notificación para {device_id}...")
    try:
        conn = psycopg2.connect(host=DB_HOST, user=DB_USER, password=DB_PASS, dbname=DB_NAME)
        cursor = conn.cursor()
        sql_update_query = """
            UPDATE clientes 
            SET notificacion_corte_3dias_enviada = false, 
                notificacion_dia_corte_enviada = false
            WHERE device_id = %s
        """
        cursor.execute(sql_update_query, (device_id,))
        conn.commit()
    except Exception as e:
        print(f"❌ ERROR al resetear banderas para {device_id}: {e}")
    finally:
        if 'cursor' in locals(): cursor.close()
        if 'conn' in locals(): conn.close()

# --- 6. Funciones de InfluxDB y APIs Externas ---

# --- MEJORA: Se añade un decorador de reintentos para robustez ---
@retry(wait=wait_exponential(multiplier=1, min=4, max=10), stop=stop_after_attempt(3))
def obtener_consumo_kwh_en_rango(client_influx, device_id, fecha_inicio_aware, fecha_fin_aware):
    """
    Obtiene el total de kWh consumidos en un rango de fechas, manejando zonas horarias.
    """
    mac_completa = str(device_id).replace(":", "")
    device_id_influx = f"LETE-{mac_completa[2:4]}{mac_completa[0:2]}".upper()
    
    # --- MEJORA: Conversión a UTC y formato RFC3339 para InfluxDB ---
    fecha_inicio_utc = fecha_inicio_aware.astimezone(pytz.utc).isoformat().replace('+00:00', 'Z')
    fecha_fin_utc = fecha_fin_aware.astimezone(pytz.utc).isoformat().replace('+00:00', 'Z')

    query = f"""
        SELECT time, power
        FROM "energia_estado"
        WHERE "device" = '{device_id_influx}' AND time >= '{fecha_inicio_utc}' AND time < '{fecha_fin_utc}'
    """
    try:
        tabla = client_influx.query(query=query, language="sql")
        df = tabla.to_pandas().dropna(subset=['power', 'time'])
        if df.empty:
            return 0.0, None # Devuelve consumo 0.0 y un DataFrame vacío

        df['time'] = pd.to_datetime(df['time'])
        df = df.set_index('time').sort_index()
        
        # Interpolar para rellenar huecos y calcular energía de forma precisa
        df_resampled = df['power'].resample('5min').mean()
        df_interpolated = df_resampled.interpolate(method='linear')
        
        kwh_intervalo = (df_interpolated / 1000) * (5 / 60.0)
        
        # Devuelve el total y el DataFrame detallado por día para análisis posterior
        consumo_diario = kwh_intervalo.resample('D').sum()
        return kwh_intervalo.sum(), consumo_diario

    except Exception as e:
        print(f"❌ ERROR al consultar kWh en rango para {device_id}: {e}")
        return None, None # Devuelve None en caso de fallo en la consulta

# --- MEJORA: Se añade un decorador de reintentos para robustez ---
@retry(wait=wait_exponential(multiplier=1, min=4, max=10), stop=stop_after_attempt(3))
def enviar_alerta_whatsapp(telefono_destino, content_sid, content_variables):
    """Envía un mensaje usando una Plantilla de WhatsApp."""
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
        response.raise_for_status() # Esto hará que el decorador @retry se active en caso de error 4xx/5xx

# --- 7. Funciones de Lógica de Negocio ---
def calcular_costo_estimado(kwh_consumidos, tipo_tarifa):
    # (Esta función fue refactorizada en el paso anterior y se mantiene)
    """Calcula el costo aproximado del recibo de CFE usando la estructura de tarifas."""
    if tipo_tarifa not in TARIFAS_CFE:
        print(f"⚠️  Advertencia: Tarifa '{tipo_tarifa}' no reconocida. No se puede calcular el costo.")
        return 0.0

    costo_sin_iva = 0.0
    kwh_restantes = kwh_consumidos
    limite_anterior = 0

    for escalon in TARIFAS_CFE[tipo_tarifa]:
        limite_actual = escalon['hasta_kwh']
        kwh_en_este_escalon = min(kwh_restantes, limite_actual - limite_anterior)
        costo_sin_iva += kwh_en_este_escalon * escalon['precio']
        kwh_restantes -= kwh_en_este_escalon
        if kwh_restantes <= 0: break
        limite_anterior = limite_actual
            
    return costo_sin_iva * IVA

def calcular_fechas_corte(hoy_aware, dia_de_corte, ciclo_bimestral):
    """Calcula la fecha de corte más reciente y la próxima, siendo consciente de la zona horaria."""
    mes_inicio_ciclo = 2 if ciclo_bimestral == 'par' else 1
    ultima_fecha = None
    
    for i in range(6):
        mes_candidato = hoy_aware.month - i
        ano_candidato = hoy_aware.year
        if mes_candidato <= 0:
            mes_candidato += 12
            ano_candidato -= 1
        
        if (mes_candidato - mes_inicio_ciclo) % 2 == 0:
            try:
                fecha_candidata = date(ano_candidato, mes_candidato, dia_de_corte)
                if fecha_candidata < hoy_aware.date():
                    ultima_fecha = fecha_candidata
                    break
            except ValueError: continue

    if not ultima_fecha: return None, None
        
    proximo_mes = ultima_fecha.month + 2
    proximo_ano = ultima_fecha.year
    if proximo_mes > 12:
        proximo_mes -= 12
        proximo_ano += 1
        
    proxima_fecha = date(proximo_ano, proximo_mes, dia_de_corte)
    return ultima_fecha, proxima_fecha

def procesar_un_cliente(cliente_data, client_influx, hoy_aware):
    """
    Encapsula toda la lógica para un único cliente.
    """
    (device_id, telefono, kwh_promedio, nombre, dia_de_corte, tipo_tarifa, 
     fecha_inicio_servicio, ciclo_bimestral, notif_3dias_enviada, notif_corte_enviada) = cliente_data
    
    print(f"\n--- Procesando cliente: {nombre} ({device_id}) ---")

    hoy_date = hoy_aware.date()
    ultima_fecha_de_corte, proxima_fecha_de_corte = calcular_fechas_corte(hoy_aware, dia_de_corte, ciclo_bimestral)
    
    if not ultima_fecha_de_corte:
        print(f"⚠️ No se pudo determinar la fecha de corte para {nombre}. Omitiendo cliente.")
        return

    # --- PASO 1: LÓGICA DE NOTIFICACIONES ESPECIALES ---
    dias_restantes = (proxima_fecha_de_corte - hoy_date).days
    
    if dias_restantes == 3 and not notif_3dias_enviada:
        print("INFO: Enviando alerta de 3 días para el corte.")
        variables = {"1": nombre, "2": proxima_fecha_de_corte.strftime('%d de %B')}
        enviar_alerta_whatsapp(telefono, CONTENT_SID_AVISO_CORTE_3DIAS, variables)
        marcar_notificacion_enviada(device_id, 'notificacion_corte_3dias')
        return # Terminamos hoy, ya que este aviso es prioritario

    if dias_restantes == 0 and not notif_corte_enviada:
        print("INFO: Enviando alerta de día de corte.")
        variables = {"1": nombre}
        enviar_alerta_whatsapp(telefono, CONTENT_SID_AVISO_DIA_DE_CORTE, variables)
        marcar_notificacion_enviada(device_id, 'notificacion_dia_corte')
        return # Terminamos, no se envía el reporte diario normal este día.
        
    # --- PASO 2: LÓGICA DEL REPORTE DIARIO ---
    ayer_date = hoy_date - timedelta(days=1)
    inicio_ayer_aware = ZONA_HORARIA_LOCAL.localize(datetime.combine(ayer_date, datetime.min.time()))
    fin_ayer_aware = ZONA_HORARIA_LOCAL.localize(datetime.combine(hoy_date, datetime.min.time()))
    kwh_ayer, _ = obtener_consumo_kwh_en_rango(client_influx, device_id, inicio_ayer_aware, fin_ayer_aware)
    if kwh_ayer is None: return

    fecha_inicio_periodo_date = ultima_fecha_de_corte
    if fecha_inicio_servicio and fecha_inicio_servicio > ultima_fecha_de_corte:
        fecha_inicio_periodo_date = fecha_inicio_servicio
    inicio_periodo_aware = ZONA_HORARIA_LOCAL.localize(datetime.combine(fecha_inicio_periodo_date, datetime.min.time()))
    kwh_periodo_actual, consumos_diarios_series = obtener_consumo_kwh_en_rango(client_influx, device_id, inicio_periodo_aware, fin_ayer_aware)
    if kwh_periodo_actual is None: return

    promedio_float = float(kwh_promedio) if kwh_promedio is not None else 0.0
    linea_comparativa = ""
    if promedio_float > 0:
        porcentaje_dif = ((kwh_ayer - promedio_float) / promedio_float) * 100
        if kwh_ayer > promedio_float: linea_comparativa = f"Es un {abs(porcentaje_dif):.0f}% más que tu promedio diario. 📈"
        else: linea_comparativa = f"¡Excelente! Ahorraste un {abs(porcentaje_dif):.0f}% respecto a tu promedio diario. 📉"

    # --- Lógica para elegir la plantilla correcta ---
    numero_dias_transcurridos = len(consumos_diarios_series) if consumos_diarios_series is not None else 0
    
    content_sid_a_usar = None
    variables_plantilla = {}

    if numero_dias_transcurridos >= MIN_DIAS_PARA_PROYECCION:
        # CASO 1: Hay suficientes días, enviamos el reporte COMPLETO
        promedio_diario_real = kwh_periodo_actual / numero_dias_transcurridos
        dias_del_ciclo = (proxima_fecha_de_corte - ultima_fecha_de_corte).days
        proyeccion_kwh = promedio_diario_real * dias_del_ciclo
        costo_estimado = calcular_costo_estimado(proyeccion_kwh, tipo_tarifa)
        
        content_sid_a_usar = CONTENT_SID_REPORTE_DIARIO
        variables_plantilla = {
            "1": nombre, "2": f"{kwh_ayer:.2f}", "3": linea_comparativa,
            "4": f"{kwh_periodo_actual:.2f}", "5": f"{costo_estimado:.2f}"
        }
    else:
        # CASO 2: Aún no hay suficientes días, enviamos el reporte INICIAL (sin proyección)
        content_sid_a_usar = os.environ.get("CONTENT_SID_REPORTE_INICIAL") # Leemos el nuevo SID
        variables_plantilla = {
            "1": nombre, "2": f"{kwh_ayer:.2f}", "3": linea_comparativa,
            "4": f"{kwh_periodo_actual:.2f}"
        }

    # Revisa si es un cliente nuevo para sobreescribir la plantilla si es necesario
    if fecha_inicio_servicio and (hoy_date - fecha_inicio_servicio).days < 60:
        content_sid_a_usar = CONTENT_SID_AVISO_NUEVO
        
    enviar_alerta_whatsapp(telefono, content_sid_a_usar, variables_plantilla)

    # --- PASO 3: LÓGICA DE FIN DE CICLO (AL FINAL DE TODO) ---
    if hoy_date == proxima_fecha_de_corte:
        print(f"¡Fin de periodo detectado para {nombre}! Realizando tareas de cierre...")
        
        inicio_bimestre_pasado = ZONA_HORARIA_LOCAL.localize(datetime.combine(ultima_fecha_de_corte, datetime.min.time()))
        fin_bimestre_pasado = ZONA_HORARIA_LOCAL.localize(datetime.combine(proxima_fecha_de_corte, datetime.min.time()))
        
        consumo_total_bimestre, _ = obtener_consumo_kwh_en_rango(client_influx, device_id, inicio_bimestre_pasado, fin_bimestre_pasado)
        
        if consumo_total_bimestre is not None and consumo_total_bimestre > 0:
            dias_del_bimestre = (proxima_fecha_de_corte - ultima_fecha_de_corte).days
            nuevo_promedio = consumo_total_bimestre / dias_del_bimestre if dias_del_bimestre > 0 else 0
            actualizar_promedio_cliente(device_id, nuevo_promedio)
        
        # Ahora sí, reseteamos las banderas para que el siguiente ciclo comience limpio.
        resetear_banderas_notificacion(device_id)

        
# --- 9. Ejecución Principal ---
def main():
    print("=" * 45)
    print(f"--- Iniciando Script de Reporte Diario v3.0 ---")
    
    try:
        client_influx = InfluxDBClient3(host=INFLUX_URL, token=INFLUX_TOKEN, org=INFLUX_ORG, database=INFLUX_BUCKET)
        print("✅ Conexión con InfluxDB exitosa.")
    except Exception as e:
        print(f"❌ ERROR de conexión con InfluxDB. Abortando. Detalles: {e}")
        return

    clientes = obtener_clientes()
    if not clientes:
        print("No hay clientes para procesar. Terminando script.")
        return

    # --- MEJORA: Obtenemos la hora actual una sola vez con zona horaria ---
    ahora_aware = datetime.now(ZONA_HORARIA_LOCAL)
    print(f"Ejecutando a las {ahora_aware.strftime('%Y-%m-%d %H:%M:%S %Z')}")

    for cliente in clientes:
        try:
            procesar_un_cliente(cliente, client_influx, ahora_aware)
        except Exception as e:
            nombre_cliente = cliente[3] if len(cliente) > 3 else "ID Desconocido"
            print(f"❌ ERROR INESPERADO al procesar al cliente '{nombre_cliente}'. Saltando al siguiente.")
            print(f"   Detalles del error: {e}")

    print("\n--- Script de Reporte Diario v3.0 completado. ---")
    print("=" * 45)


if __name__ == "__main__":
    main()