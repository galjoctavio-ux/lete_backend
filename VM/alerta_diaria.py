# -------------------------------------------------------------------
# Script de Alertas Diarias para LETE v3.6 (Lógica Esencial Corregida)
# - Se reestructura el flujo para cumplir con las reglas de negocio clave.
# - Se implementa la selección de plantillas correcta (mayor/menor consumo).
# - Se corrige el mensaje del día de corte para incluir el resumen final..
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
import calendar

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
# --- NOTA: Asegúrate de tener estas 5 variables en tu archivo .env ---
CONTENT_SID_AVISO_CORTE_3DIAS = os.environ.get("CONTENT_SID_AVISO_CORTE_3DIAS")
CONTENT_SID_DIA_DE_CORTE = os.environ.get("CONTENT_SID_DIA_DE_CORTE") # Para el día de corte
CONTENT_SID_REPORTE_INICIAL = os.environ.get("CONTENT_SID_REPORTE_INICIAL") # Sin proyección
CONTENT_SID_REPORTE_MAS = os.environ.get("CONTENT_SID_REPORTE_MAS") # Con proyección (consumo mayor)
CONTENT_SID_REPORTE_MENOS = os.environ.get("CONTENT_SID_REPORTE_MENOS") # Con proyección (consumo menor)

# --- Lógica de Negocio y Reglas ---
IVA = 1.16
ZONA_HORARIA_LOCAL = pytz.timezone('America/Mexico_City')
MIN_DIAS_PARA_PROYECCION = 5

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
def obtener_clientes():
    """Obtiene la lista de clientes y sus datos relevantes de Supabase."""
    try:
        conn = psycopg2.connect(host=DB_HOST, user=DB_USER, password=DB_PASS, dbname=DB_NAME)
        cursor = conn.cursor()
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
        cursor.execute(sql_update_query, (float(nuevo_promedio), device_id))
        conn.commit()
        print(f"✅ Promedio para {device_id} actualizado exitosamente.")
    except Exception as e:
        print(f"❌ ERROR al actualizar el promedio para {device_id}: {e}")
    finally:
        if 'cursor' in locals() and not cursor.closed: cursor.close()
        if 'conn' in locals() and not conn.closed: conn.close()

def marcar_notificacion_enviada(device_id, tipo_notificacion):
    """Marca una notificación de corte como enviada para no repetirla."""
    columna_a_actualizar = f"{tipo_notificacion}_enviada"
    print(f"Marcando bandera '{columna_a_actualizar}' para {device_id}...")
    try:
        conn = psycopg2.connect(host=DB_HOST, user=DB_USER, password=DB_PASS, dbname=DB_NAME)
        cursor = conn.cursor()
        if columna_a_actualizar not in ["notificacion_corte_3dias_enviada", "notificacion_dia_corte_enviada"]:
            print(f"⚠️  Intento de actualizar columna no permitida: {columna_a_actualizar}")
            return
        sql_update_query = f"UPDATE clientes SET {columna_a_actualizar} = true WHERE device_id = %s"
        cursor.execute(sql_update_query, (device_id,))
        conn.commit()
    except Exception as e:
        print(f"❌ ERROR al actualizar bandera de notificación para {device_id}: {e}")
    finally:
        if 'cursor' in locals() and not cursor.closed: cursor.close()
        if 'conn' in locals() and not conn.closed: conn.close()

def resetear_banderas_notificacion(device_id):
    """Resetea las banderas al inicio de un nuevo ciclo."""
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
        if 'cursor' in locals() and not cursor.closed: cursor.close()
        if 'conn' in locals() and not conn.closed: conn.close()

# --- 6. Funciones de Consulta de Datos y APIs Externas ---
def obtener_consumo_desde_servidor_local(device_id, fecha_inicio_aware, fecha_fin_aware):
    """Lee el archivo CSV local, filtra los datos y calcula el consumo en kWh."""
    archivo_csv = 'mediciones.csv'
    #print(f"Leyendo {archivo_csv} para {device_id} entre {fecha_inicio_aware} y {fecha_fin_aware}")
    try:
        df = pd.read_csv(archivo_csv)
        if df.empty: return None, None 

        if df['timestamp_servidor'].dtype == 'object':
             df['timestamp_servidor'] = pd.to_datetime(df['timestamp_servidor'])

        if df['timestamp_servidor'].dt.tz is None:
            df['timestamp_servidor'] = df['timestamp_servidor'].dt.tz_localize(ZONA_HORARIA_LOCAL, ambiguous='infer')
        else:
            df['timestamp_servidor'] = df['timestamp_servidor'].dt.tz_convert(ZONA_HORARIA_LOCAL)

        df_filtrado = df[
            (df['device_id'] == device_id) &
            (df['timestamp_servidor'] >= fecha_inicio_aware) &
            (df['timestamp_servidor'] < fecha_fin_aware)
        ]
        
        if df_filtrado.empty: return None, None

        df_calculo = df_filtrado.set_index('timestamp_servidor').sort_index()
        potencia_media_W = df_calculo['power'].resample('1min').mean()
        potencia_interpolada = potencia_media_W.interpolate(method='linear', limit=60)
        kwh_intervalo = (potencia_interpolada / 1000) * (1 / 60.0)
        kwh_intervalo = kwh_intervalo.fillna(0)
        total_kwh = kwh_intervalo.sum()
        
        return total_kwh, None # No necesitamos el consumo diario agrupado

    except FileNotFoundError:
        print(f"⚠️  Error: No se encontró el archivo {archivo_csv}.")
        return None, None
    except Exception as e:
        print(f"❌ ERROR al procesar el archivo CSV para {device_id}: {e}")
        return None, None

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
        response.raise_for_status()

# --- 7. Funciones de Lógica de Negocio ---
def calcular_costo_estimado(kwh_consumidos, tipo_tarifa):
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
    """Calcula la fecha de corte más reciente y la próxima (versión simplificada y corregida)."""
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
    if not candidatos_pasados: return None, None
    ultima_fecha_de_corte = max(candidatos_pasados)
    mes_proximo = ultima_fecha_de_corte.month + 2
    ano_proximo = ultima_fecha_de_corte.year
    if mes_proximo > 12:
        mes_proximo -= 12
        ano_proximo += 1
    dia_proximo = min(dia_de_corte, calendar.monthrange(ano_proximo, mes_proximo)[1])
    proxima_fecha_de_corte = date(ano_proximo, mes_proximo, dia_proximo)
    return ultima_fecha_de_corte, proxima_fecha_de_corte

# --- 8. Lógica de Procesamiento de Clientes ---
def _enviar_alerta_3_dias(cliente, proxima_fecha_de_corte):
    (device_id, telefono, _, nombre, _, _, _, _, _, _) = cliente
    print("INFO: Enviando alerta de 3 días para el corte.")
    variables = {"1": nombre, "2": proxima_fecha_de_corte.strftime('%d de %B')}
    enviar_alerta_whatsapp(telefono, CONTENT_SID_AVISO_CORTE_3DIAS, variables)
    marcar_notificacion_enviada(device_id, 'notificacion_corte_3dias')

def _enviar_alerta_dia_de_corte(cliente, ultima_corte, proxima_corte):
    (device_id, telefono, _, nombre, _, tipo_tarifa, _, _, _, _) = cliente
    print("INFO: Enviando alerta de DÍA DE CORTE con resumen final.")
    
    # Calcula el consumo final del periodo que HOY termina
    inicio_periodo = ZONA_HORARIA_LOCAL.localize(datetime.combine(ultima_corte, datetime.min.time()))
    fin_periodo = ZONA_HORARIA_LOCAL.localize(datetime.combine(proxima_corte, datetime.min.time()))
    consumo_final, _ = obtener_consumo_desde_servidor_local(device_id, inicio_periodo, fin_periodo)
    
    if consumo_final is None: consumo_final = 0.0
    
    costo_final = calcular_costo_estimado(consumo_final, tipo_tarifa)
    
    variables = {"1": nombre, "2": f"{consumo_final:.2f}", "3": f"{costo_final:.2f}"}
    enviar_alerta_whatsapp(telefono, CONTENT_SID_DIA_DE_CORTE, variables)
    marcar_notificacion_enviada(device_id, 'notificacion_dia_corte')

def _generar_reporte_diario(cliente, hoy_aware, fechas_corte):
    (device_id, telefono, kwh_promedio, nombre, _, tipo_tarifa, fecha_inicio_servicio, _, _, _) = cliente
    ultima_fecha_de_corte, proxima_fecha_de_corte = fechas_corte
    
    ayer_date = hoy_aware.date() - timedelta(days=1)
    inicio_ayer = ZONA_HORARIA_LOCAL.localize(datetime.combine(ayer_date, datetime.min.time()))
    fin_ayer = ZONA_HORARIA_LOCAL.localize(datetime.combine(hoy_aware.date(), datetime.min.time()))
    kwh_ayer, _ = obtener_consumo_desde_servidor_local(device_id, inicio_ayer, fin_ayer)
    
    if kwh_ayer is None: 
        print(f"INFO: No se encontraron datos de consumo de ayer para {nombre}. No se enviará reporte.")
        return

    fecha_inicio_servicio_date = fecha_inicio_servicio.date() if isinstance(fecha_inicio_servicio, datetime) else fecha_inicio_servicio
    fecha_inicio_periodo = ultima_fecha_de_corte
    if fecha_inicio_servicio_date and fecha_inicio_servicio_date > ultima_fecha_de_corte:
        fecha_inicio_periodo = fecha_inicio_servicio_date
    
    inicio_periodo = ZONA_HORARIA_LOCAL.localize(datetime.combine(fecha_inicio_periodo, datetime.min.time()))
    kwh_periodo_actual, _ = obtener_consumo_desde_servidor_local(device_id, inicio_periodo, fin_ayer)

    if kwh_periodo_actual is None: kwh_periodo_actual = 0.0
        
    promedio_float = float(kwh_promedio) if kwh_promedio is not None else 0.0
    
    numero_dias_transcurridos = (ayer_date - fecha_inicio_periodo).days + 1
    
    # --- LÓGICA DE SELECCIÓN DE PLANTILLA ---
    if numero_dias_transcurridos < MIN_DIAS_PARA_PROYECCION:
        variables = {"1": nombre, "2": f"{kwh_ayer:.2f}", "3": f"{kwh_periodo_actual:.2f}"}
        enviar_alerta_whatsapp(telefono, CONTENT_SID_REPORTE_INICIAL, variables)
    else:
        dias_del_ciclo = (proxima_fecha_de_corte - ultima_fecha_de_corte).days
        proyeccion_kwh = (kwh_periodo_actual / numero_dias_transcurridos) * dias_del_ciclo
        costo_estimado = calcular_costo_estimado(proyeccion_kwh, tipo_tarifa)
        variables = {"1": nombre, "2": f"{kwh_ayer:.2f}", "3": f"{kwh_periodo_actual:.2f}", "4": f"{costo_estimado:.2f}"}
        
        if kwh_ayer > promedio_float:
            enviar_alerta_whatsapp(telefono, CONTENT_SID_REPORTE_MAS, variables)
        else:
            enviar_alerta_whatsapp(telefono, CONTENT_SID_REPORTE_MENOS, variables)

def _realizar_cierre_de_ciclo(cliente, fechas_corte):
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
    """Orquesta el procesamiento completo para un único cliente."""
    (device_id, _, _, nombre, dia_de_corte, _, _, ciclo_bimestral, notif_3dias_enviada, notif_corte_enviada) = cliente_data
    print(f"\n--- Procesando cliente: {nombre} ({device_id}) ---")
    
    ultima_corte, proxima_corte = calcular_fechas_corte(hoy_aware, dia_de_corte, ciclo_bimestral)
    if not ultima_corte or not proxima_corte:
        print(f"⚠️ No se pudo determinar el periodo de corte para {nombre}. Omitiendo.")
        return
    
    hoy = hoy_aware.date()
    dias_restantes = (proxima_corte - hoy).days

    # --- FLUJO LÓGICO BASADO EN REGLAS DE NEGOCIO ---
    
    # REGLA 1: Hoy es el día de corte (máxima prioridad).
    if dias_restantes == 0 and not notif_corte_enviada:
        _enviar_alerta_dia_de_corte(cliente_data, ultima_corte, proxima_corte)
        return # No se hace nada más hoy.

    # REGLA 2: Hoy es el día DESPUÉS del corte.
    if hoy == ultima_corte + timedelta(days=1):
         _realizar_cierre_de_ciclo(cliente_data, (ultima_corte-timedelta(days=60), ultima_corte))

    # REGLA 3: Faltan 3 días para el corte.
    if dias_restantes == 3 and not notif_3dias_enviada:
        _enviar_alerta_3_dias(cliente_data, proxima_corte)
        return # No se envía reporte diario hoy.
    
    # REGLA 4: Si no se cumplió ninguna regla anterior, se envía el reporte diario.
    _generar_reporte_diario(cliente_data, hoy_aware, (ultima_corte, proxima_corte))

# --- 9. Ejecución Principal ---
def main():
    print("=" * 50)
    print(f"--- Iniciando Script de Reporte Diario v3.6 ---")
    
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

    print("\n--- Script de Reporte Diario v3.6 completado. ---")
    print("=" * 50)

if __name__ == "__main__":
    main()