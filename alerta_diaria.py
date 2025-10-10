# -------------------------------------------------------------------
# Script de Alertas Diarias para LETE v3.1 (Refactorizado)
# - Se elimina InfluxDB para usar un servidor local de datos.
# - Se reestructura la lógica de procesamiento de clientes.
# -------------------------------------------------------------------

# --- 1. Importaciones ---
import psycopg2
import requests
import pandas as pd
import certifi
import os
import json
from datetime import date, datetime, timedelta
from dotenv import load_dotenv
import pytz
from tenacity import retry, stop_after_attempt, wait_exponential

# --- 2. Carga de Variables de Entorno ---
load_dotenv()

# --- 3. Configuración SSL ---
os.environ['GRPC_DEFAULT_SSL_ROOTS_FILE_PATH'] = certifi.where()

# --- 4. Configuración General (desde .env) ---

DB_HOST = os.environ.get("DB_HOST")
DB_USER = os.environ.get("DB_USER")
DB_PASS = os.environ.get("DB_PASS")
DB_NAME = os.environ.get("DB_NAME")

TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN")
TWILIO_FROM_NUMBER = os.environ.get("TWILIO_FROM_NUMBER")
TWILIO_URL = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json"

# --- IDs de Plantillas de Mensajes (Templates) ---
CONTENT_SID_REPORTE_DIARIO = os.environ.get("CONTENT_SID_REPORTE_DIARIO")
CONTENT_SID_AVISO_NUEVO = os.environ.get("CONTENT_SID_AVISO_NUEVO")
CONTENT_SID_AVISO_CORTE_3DIAS = os.environ.get("CONTENT_SID_AVISO_CORTE_3DIAS")
CONTENT_SID_AVISO_DIA_DE_CORTE = os.environ.get("CONTENT_SID_AVISO_DIA_DE_CORTE")
# --- MODIFICADO: Se centraliza la carga de esta variable ---
CONTENT_SID_REPORTE_INICIAL = os.environ.get("CONTENT_SID_REPORTE_INICIAL") 

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
    ],
    'DAC': [
        {'hasta_kwh': float('inf'), 'precio': 7.80}
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

# --- 6. Funciones de Consulta de Datos y APIs Externas ---

def obtener_consumo_desde_servidor_local(device_id, fecha_inicio_aware, fecha_fin_aware):
    """
    Lee el archivo CSV local, filtra los datos para un dispositivo y rango de fechas, 
    y calcula el consumo total y diario en kWh.
    """
    archivo_csv = 'mediciones.csv'
    print(f"Leyendo {archivo_csv} para el dispositivo {device_id}...")

    try:
        # 1. Leer el archivo CSV con Pandas
        df = pd.read_csv(archivo_csv)
        if df.empty:
            return 0.0, pd.Series()

        # 2. Convertir la columna de timestamp a objetos de fecha (timezone-aware)
        df['timestamp_servidor'] = pd.to_datetime(df['timestamp_servidor'], utc=True)

        # 3. Filtrar los datos por el device_id y el rango de fechas
        df_filtrado = df[
            (df['device_id'] == device_id) &
            (df['timestamp_servidor'] >= fecha_inicio_aware) &
            (df['timestamp_servidor'] < fecha_fin_aware)
        ]

        if df_filtrado.empty:
            return 0.0, pd.Series()

        # 4. Calcular la energía (kWh) a partir de la potencia (W)
        df_calculo = df_filtrado.set_index('timestamp_servidor').sort_index()
        
        # Se remuestrea la potencia a intervalos de 1 minuto para un cálculo preciso
        potencia_media_W = df_calculo['power'].resample('1min').mean()
        potencia_interpolada = potencia_media_W.interpolate(method='linear')
        
        # Energía (kWh) = (Potencia (W) / 1000) * (Intervalo (min) / 60)
        kwh_intervalo = (potencia_interpolada / 1000) * (1 / 60.0)

        # 5. Calcular el total y el desglose diario
        total_kwh = kwh_intervalo.sum()
        consumo_diario = kwh_intervalo.resample('D').sum()

        return total_kwh, consumo_diario

    except FileNotFoundError:
        print(f"⚠️  Error: No se encontró el archivo {archivo_csv}.")
        return None, None
    except Exception as e:
        print(f"❌ ERROR al procesar el archivo CSV para {device_id}: {e}")
        return None, None

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
        response.raise_for_status() # Esto hará que el decorador @retry se active

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

# --- 8. Lógica de Procesamiento de Clientes (REFACTORIZADO) ---
# --- 8. Lógica de Procesamiento de Clientes (REFACTORIZADO) ---

def _gestionar_alertas_de_corte(cliente, hoy_date, proxima_fecha_de_corte):
    """Revisa y envía alertas de corte. Devuelve True si se envió una."""
    (device_id, telefono, _, nombre, _, _, _, _, notif_3dias_enviada, notif_corte_enviada) = cliente
    dias_restantes = (proxima_fecha_de_corte - hoy_date).days

    if dias_restantes == 3 and not notif_3dias_enviada:
        print("INFO: Enviando alerta de 3 días para el corte.")
        variables = {"1": nombre, "2": proxima_fecha_de_corte.strftime('%d de %B')}
        enviar_alerta_whatsapp(telefono, CONTENT_SID_AVISO_CORTE_3DIAS, variables)
        marcar_notificacion_enviada(device_id, 'notificacion_corte_3dias')
        return True # Se envió una alerta, no continuar hoy.

    if dias_restantes == 0 and not notif_corte_enviada:
        print("INFO: Enviando alerta de día de corte.")
        variables = {"1": nombre}
        enviar_alerta_whatsapp(telefono, CONTENT_SID_AVISO_DIA_DE_CORTE, variables)
        marcar_notificacion_enviada(device_id, 'notificacion_dia_corte')
        return True # Se envió una alerta, no continuar hoy.

    return False

def _generar_reporte_diario(cliente, hoy_aware, fechas_corte):
    """Genera y envía el reporte diario de consumo."""
    (device_id, telefono, kwh_promedio, nombre, _, tipo_tarifa, fecha_inicio_servicio, _, _, _) = cliente
    ultima_fecha_de_corte, proxima_fecha_de_corte = fechas_corte
    
    # Obtener consumo de ayer
    ayer_date = hoy_aware.date() - timedelta(days=1)
    inicio_ayer = ZONA_HORARIA_LOCAL.localize(datetime.combine(ayer_date, datetime.min.time()))
    fin_ayer = ZONA_HORARIA_LOCAL.localize(datetime.combine(hoy_aware.date(), datetime.min.time()))
    kwh_ayer, _ = obtener_consumo_desde_servidor_local(device_id, inicio_ayer, fin_ayer)
    if kwh_ayer is None: return

    # Obtener consumo del periodo actual
    # Si el cliente es nuevo, el periodo empieza en su fecha de inicio, si no, en la última fecha de corte
    fecha_inicio_periodo = ultima_fecha_de_corte
    if fecha_inicio_servicio and fecha_inicio_servicio > ultima_fecha_de_corte:
        fecha_inicio_periodo = fecha_inicio_servicio

    inicio_periodo = ZONA_HORARIA_LOCAL.localize(datetime.combine(fecha_inicio_periodo, datetime.min.time()))
    kwh_periodo_actual, consumos_diarios_series = obtener_consumo_desde_servidor_local(device_id, inicio_periodo, fin_ayer)
    if kwh_periodo_actual is None: return

    # Lógica para crear la línea de comparación con el promedio
    promedio_float = float(kwh_promedio) if kwh_promedio is not None else 0.0
    linea_comparativa = ""
    if promedio_float > 0:
        porcentaje_dif = ((kwh_ayer - promedio_float) / promedio_float) * 100
        if kwh_ayer > promedio_float:
            linea_comparativa = f"Es un {abs(porcentaje_dif):.0f}% más que tu promedio diario. 📈"
        else:
            linea_comparativa = f"¡Excelente! Ahorraste un {abs(porcentaje_dif):.0f}% respecto a tu promedio diario. 📉"

    # Lógica para elegir la plantilla correcta
    numero_dias_transcurridos = len(consumos_diarios_series) if consumos_diarios_series is not None else 0
    
    if numero_dias_transcurridos >= MIN_DIAS_PARA_PROYECCION:
        # Reporte COMPLETO con proyección
        promedio_diario_real = kwh_periodo_actual / numero_dias_transcurridos
        dias_del_ciclo = (proxima_fecha_de_corte - ultima_fecha_de_corte).days
        proyeccion_kwh = promedio_diario_real * dias_del_ciclo
        costo_estimado = calcular_costo_estimado(proyeccion_kwh, tipo_tarifa)
        variables = {"1": nombre, "2": f"{kwh_ayer:.2f}", "3": linea_comparativa, "4": f"{kwh_periodo_actual:.2f}", "5": f"{costo_estimado:.2f}"}
        enviar_alerta_whatsapp(telefono, CONTENT_SID_REPORTE_DIARIO, variables)
    else:
        # Reporte INICIAL sin proyección
        variables = {"1": nombre, "2": f"{kwh_ayer:.2f}", "3": linea_comparativa, "4": f"{kwh_periodo_actual:.2f}"}
        enviar_alerta_whatsapp(telefono, CONTENT_SID_REPORTE_INICIAL, variables)

def _realizar_cierre_de_ciclo(cliente, fechas_corte):
    """Realiza tareas de fin de ciclo: recalcular promedio y resetear banderas."""
    (device_id, _, _, nombre, _, _, _, _, _, _) = cliente
    ultima_fecha_de_corte, proxima_fecha_de_corte = fechas_corte

    print(f"¡Fin de periodo para {nombre}! Realizando cierre...")
    
    inicio_bimestre = ZONA_HORARIA_LOCAL.localize(datetime.combine(ultima_fecha_de_cote, datetime.min.time()))
    fin_bimestre = ZONA_HORARIA_LOCAL.localize(datetime.combine(proxima_fecha_de_corte, datetime.min.time()))
    
    consumo_total_bimestre, _ = obtener_consumo_desde_servidor_local(device_id, inicio_bimestre, fin_bimestre)
    
    if consumo_total_bimestre is not None and consumo_total_bimestre > 0:
        dias_del_bimestre = (proxima_fecha_de_corte - ultima_fecha_de_corte).days
        if dias_del_bimestre > 0:
            nuevo_promedio = consumo_total_bimestre / dias_del_bimestre
            actualizar_promedio_cliente(device_id, nuevo_promedio)
    
    resetear_banderas_notificacion(device_id)

def procesar_un_cliente(cliente_data, hoy_aware):
    """
    Orquesta el procesamiento completo para un único cliente.
    """
    nombre = cliente_data[3]
    print(f"\n--- Procesando cliente: {nombre} ({cliente_data[0]}) ---")

    dia_de_corte = cliente_data[4]
    ciclo_bimestral = cliente_data[7]
    
    ultima_corte, proxima_corte = calcular_fechas_corte(hoy_aware, dia_de_corte, ciclo_bimestral)
    if not ultima_corte:
        print(f"⚠️ No se pudo determinar la fecha de corte para {nombre}. Omitiendo.")
        return

    # PASO 1: Gestionar alertas prioritarias de corte. Si se envía una, se detiene el proceso de hoy.
    if _gestionar_alertas_de_corte(cliente_data, hoy_aware.date(), proxima_corte):
        return

    # PASO 2: Si no hubo alertas de corte, generar el reporte diario.
    _generar_reporte_diario(cliente_data, hoy_aware, (ultima_corte, proxima_corte))

    # PASO 3: Si hoy es el día de corte, realizar las tareas de cierre de ciclo.
    if hoy_aware.date() == proxima_corte:
        _realizar_cierre_de_ciclo(cliente_data, (ultima_corte, proxima_corte))

def _realizar_cierre_de_ciclo(cliente, fechas_corte):
    """Realiza tareas de fin de ciclo: recalcular promedio y resetear banderas."""
    (device_id, _, _, nombre, _, _, _, _, _, _) = cliente
    ultima_fecha_de_corte, proxima_fecha_de_corte = fechas_corte

    print(f"¡Fin de periodo para {nombre}! Realizando cierre...")
    
    inicio_bimestre = ZONA_HORARIA_LOCAL.localize(datetime.combine(ultima_fecha_de_corte, datetime.min.time()))
    fin_bimestre = ZONA_HORARIA_LOCAL.localize(datetime.combine(proxima_fecha_de_corte, datetime.min.time()))
    
    consumo_total_bimestre, _ = obtener_consumo_desde_servidor_local(device_id, inicio_bimestre, fin_bimestre)
    
    if consumo_total_bimestre is not None and consumo_total_bimestre > 0:
        dias_del_bimestre = (proxima_fecha_de_corte - ultima_fecha_de_corte).days
        if dias_del_bimestre > 0:
            nuevo_promedio = consumo_total_bimestre / dias_del_bimestre
            actualizar_promedio_cliente(device_id, nuevo_promedio)
    
    resetear_banderas_notificacion(device_id)

def procesar_un_cliente(cliente_data, hoy_aware):
    """
    Orquesta el procesamiento completo para un único cliente.
    """
    nombre = cliente_data[3]
    device_id = cliente_data[0]
    dia_de_corte = cliente_data[4]
    ciclo_bimestral = cliente_data[7]
    
    print(f"\n--- Procesando cliente: {nombre} ({device_id}) ---")
    
    ultima_corte, proxima_corte = calcular_fechas_corte(hoy_aware, dia_de_corte, ciclo_bimestral)
    if not ultima_corte:
        print(f"⚠️ No se pudo determinar la fecha de corte para {nombre}. Omitiendo.")
        return

    # PASO 1: Gestionar alertas prioritarias de corte. Si se envía una, se detiene el proceso de hoy.
    if _gestionar_alertas_de_corte(cliente_data, hoy_aware.date(), proxima_corte):
        return

    # PASO 2: Si no hubo alertas de corte, generar el reporte diario.
    _generar_reporte_diario(cliente_data, hoy_aware, (ultima_corte, proxima_corte))

    # PASO 3: Si hoy es el día de corte, realizar las tareas de cierre de ciclo.
    if hoy_aware.date() == proxima_corte:
        _realizar_cierre_de_ciclo(cliente_data, (ultima_corte, proxima_corte))

        
# --- 9. Ejecución Principal ---
def main():
    print("=" * 50)
    print(f"--- Iniciando Script de Reporte Diario v3.2 ---")
    
    clientes = obtener_clientes()
    if not clientes:
        print("No hay clientes para procesar. Terminando script.")
        return

    ahora_aware = datetime.now(ZONA_HORARIA_LOCAL)
    print(f"Ejecutando a las {ahora_aware.strftime('%Y-%m-%d %H:%M:%S %Z')}")

    for cliente in clientes:
        try:
            procesar_un_cliente(cliente, ahora_aware)
        except Exception as e:
            nombre_cliente = cliente[3] if len(cliente) > 3 else "ID Desconocido"
            print(f"❌ ERROR INESPERADO al procesar '{nombre_cliente}'. Saltando. Error: {e}")

    print("\n--- Script de Reporte Diario v3.2 completado. ---")
    print("=" * 50)

if __name__ == "__main__":
    main()