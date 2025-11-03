# -------------------------------------------------------------------
# Script de Alertas Diarias para LETE v4.1 (Integración con Telegram)
# - Lee datos de consumo desde InfluxDB en lugar de CSV.
# - Consultas a PostgreSQL actualizadas para la nueva estructura (clientes/dispositivos_lete).
# - Se implementa la lógica de "Primer Periodo" para proyecciones precisas.
# - AÑADIDO: Envío de alertas dual a WhatsApp y Telegram.
# - CORREGIDO: Lógica de proyección para evitar valores inflados.
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

# --- ¡NUEVA IMPORTACIÓN REQUERIDA! ---
from influxdb_client import InfluxDBClient

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

# --- ¡NUEVA CONFIGURACIÓN DE TELEGRAM! ---
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
# (No se usa ADMIN_TELEGRAM_CHAT_ID aquí, pero es bueno tenerlo)

# --- ¡NUEVA CONFIGURACIÓN DE INFLUXDB! ---
INFLUX_URL = os.environ.get("INFLUX_URL")
INFLUX_TOKEN = os.environ.get("INFLUX_TOKEN")
INFLUX_ORG = os.environ.get("INFLUX_ORG")
INFLUX_BUCKET = os.environ.get("INFLUX_BUCKET_NEW") # Usamos el bucket de receptor_mqtt

# --- IDs de Plantillas de Mensajes (Templates) ---
CONTENT_SID_AVISO_CORTE_3DIAS = os.environ.get("CONTENT_SID_AVISO_CORTE_3DIAS")
CONTENT_SID_DIA_DE_CORTE = os.environ.get("CONTENT_SID_DIA_DE_CORTE")
CONTENT_SID_REPORTE_INICIAL = os.environ.get("CONTENT_SID_REPORTE_INICIAL")
CONTENT_SID_REPORTE_MAS = os.environ.get("CONTENT_SID_REPORTE_MAS")
CONTENT_SID_REPORTE_MENOS = os.environ.get("CONTENT_SID_REPORTE_MENOS")
CONTENT_SID_RECORDATORIO_CONEXION = os.environ.get("CONTENT_SID_RECORDATORIO_CONEXION")

# (Variables de plantillas del Vigilante, cargadas para el formateador)
TPL_FELICITACION_CONEXION = os.environ.get("TPL_FELICITACION_CONEXION")
TPL_PICOS_VOLTAJE = os.environ.get("TPL_PICOS_VOLTAJE")
TPL_BAJO_VOLTAJE = os.environ.get("TPL_BAJO_VOLTAJE")
TPL_FUGA_CORRIENTE = os.environ.get("TPL_FUGA_CORRIENTE")
TPL_BRINCO_ESCALON = os.environ.get("TPL_BRINCO_ESCALON")
TPL_CONSUMO_FANTASMA = os.environ.get("TPL_CONSUMO_FANTASMA")
TPL_DISPOSITIVO_OFFLINE = os.environ.get("TPL_DISPOSITIVO_OFFLINE")


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

# --- 5. Funciones de Base de Datos (MODIFICADAS) ---
def obtener_clientes():
    """
    Obtiene la lista de clientes y sus datos relevantes, uniendo las tablas
    clientes y dispositivos_lete. Incluye campos para lógica de "Primer Periodo"
    y el nuevo "telegram_chat_id".
    """
    try:
        conn = psycopg2.connect(host=DB_HOST, user=DB_USER, password=DB_PASS, dbname=DB_NAME)
        cursor = conn.cursor()
        
        # --- ¡CONSULTA MODIFICADA CON JOIN Y NUEVO CAMPO! ---
        # Se añaden lectura_cierre_periodo_anterior y lectura_medidor_inicial
        cursor.execute("""
            SELECT 
                d.device_id, 
                c.telefono_whatsapp, 
                c.telegram_chat_id,
                c.prefiere_telegram,       
                c.kwh_promedio_diario, 
                c.nombre, 
                c.dia_de_corte, 
                c.tipo_tarifa, 
                c.fecha_inicio_servicio, 
                c.ciclo_bimestral,
                c.notificacion_corte_3dias_enviada, 
                c.notificacion_dia_corte_enviada,
                c.lectura_cierre_periodo_anterior, 
                c.lectura_medidor_inicial,
                c.primera_medicion_recibida
            FROM clientes c
            JOIN dispositivos_lete d ON c.id = d.cliente_id
            WHERE c.subscription_status = 'active'
        """)
        # El orden de las columnas debe ser consistente.
        
        lista_clientes = cursor.fetchall()
        cursor.close()
        conn.close()
        print(f"✅ Se encontraron {len(lista_clientes)} clientes activos en la base de datos.")
        return lista_clientes
    except Exception as e:
        print(f"❌ ERROR al conectar con la base de datos de clientes: {e}")
        return []

def actualizar_promedio_cliente(device_id, nuevo_promedio):
    """Actualiza el kwh_promedio_diario para un cliente en Supabase (vía device_id)."""
    print(f"ACTUALIZANDO promedio para {device_id} a {nuevo_promedio:.2f} kWh/día...")
    try:
        conn = psycopg2.connect(host=DB_HOST, user=DB_USER, password=DB_PASS, dbname=DB_NAME)
        cursor = conn.cursor()
        
        # --- ¡CONSULTA MODIFICADA CON UPDATE...FROM...WHERE! ---
        sql_update_query = """
            UPDATE clientes c
            SET kwh_promedio_diario = %s
            FROM dispositivos_lete d
            WHERE c.id = d.cliente_id AND d.device_id = %s
        """
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
            
        # --- ¡CONSULTA MODIFICADA CON UPDATE...FROM...WHERE! ---
        sql_update_query = f"""
            UPDATE clientes c
            SET {columna_a_actualizar} = true
            FROM dispositivos_lete d
            WHERE c.id = d.cliente_id AND d.device_id = %s
        """
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
        
        # --- ¡CONSULTA MODIFICADA CON UPDATE...FROM...WHERE! ---
        sql_update_query = """
            UPDATE clientes c
            SET notificacion_corte_3dias_enviada = false, 
                notificacion_dia_corte_enviada = false
            FROM dispositivos_lete d
            WHERE c.id = d.cliente_id AND d.device_id = %s
        """
        cursor.execute(sql_update_query, (device_id,))
        conn.commit()
    except Exception as e:
        print(f"❌ ERROR al resetear banderas para {device_id}: {e}")
    finally:
        if 'cursor' in locals() and not cursor.closed: cursor.close()
        if 'conn' in locals() and not conn.closed: conn.close()

# --- 6. Funciones de Consulta de Datos y APIs Externas ---

# --- ¡FUNCIÓN REEMPLAZADA! ---
def obtener_consumo_desde_influxdb(device_id, fecha_inicio_aware, fecha_fin_aware):
    """
    Obtiene el consumo total de un dispositivo (en kWh) desde InfluxDB 
    para un rango de tiempo específico.
    """
    
    # Preparamos las fechas en formato ISO 8601 UTC, requerido por Flux
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
                # No se encontraron datos en InfluxDB para ese rango
                return None, None

    except Exception as e:
        print(f"❌ ERROR al consultar InfluxDB para {device_id}: {e}")
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

# --- ¡NUEVAS FUNCIONES DE TELEGRAM! ---

@retry(wait=wait_exponential(multiplier=1, min=4, max=10), stop=stop_after_attempt(3))
def enviar_alerta_telegram(chat_id, message_text):
    """Envía un mensaje de Telegram."""
    if not chat_id or not message_text:
        print(f"⚠️  Chat ID ({chat_id}) o Mensaje ({message_text}) vacío. No se envía alerta de Telegram.")
        return
    
    if not TELEGRAM_BOT_TOKEN:
        print("⚠️ ⚠️  ADVERTENCIA: TELEGRAM_BOT_TOKEN no está configurado en .env. No se puede enviar alerta.")
        return

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        'chat_id': chat_id,
        'text': message_text,
        'parse_mode': 'Markdown' # Habilitamos Markdown para **negritas**, *cursivas*, etc.
    }
    
    print(f"\nEnviando Telegram a: {chat_id}...")
    try:
        response = requests.post(url, data=payload, timeout=5)
        response_json = response.json()
        
        if response.status_code == 200 and response_json.get('ok'):
            print(f"✔️ Alerta de Telegram enviada exitosamente.")
        else:
            error_msg = response_json.get('description', response.text)
            print(f"⚠️  Error al enviar alerta de Telegram. Código: {response.status_code}, Respuesta: {error_msg}")
            response.raise_for_status()
    except requests.exceptions.RequestException as e:
        print(f"❌ ERROR de conexión al enviar alerta de Telegram: {e}")
        raise # Re-lanza para que tenacity pueda reintentar

def formatear_mensaje_telegram(template_sid, variables):
    """
    Traduce las plantillas de Twilio a mensajes de texto para Telegram.
    ¡REVISA Y AJUSTA ESTOS MENSAJES A TU GUSTO!
    """
    
    # --- Plantillas de alerta_diaria.py ---
    if template_sid == CONTENT_SID_AVISO_CORTE_3DIAS:
        return f"Hola {variables.get('1', 'usuario')}, te recordamos que tu fecha de corte es el *{variables.get('2', 'fecha')}*. 🗓"
        
    elif template_sid == CONTENT_SID_DIA_DE_CORTE:
        return f"Hola {variables.get('1', 'usuario')}, ¡hoy es tu día de corte! ✂️\n\nTu consumo final del periodo fue de *{variables.get('2', 'X.XX')} kWh*, con un costo estimado de *${variables.get('3', 'X.XX')}*."
        
    elif template_sid == CONTENT_SID_REPORTE_INICIAL:
        return f"Hola {variables.get('1', 'usuario')}, tu consumo de ayer fue de *{variables.get('2', 'X.XX')} kWh*.\nLlevas *{variables.get('3', 'X.XX')} kWh* acumulados. 📊"
        
    elif template_sid == CONTENT_SID_REPORTE_MAS:
        return f"Hola {variables.get('1', 'usuario')}, tu consumo de ayer fue de *{variables.get('2', 'X.XX')} kWh* 🔺 (más alto que tu promedio).\nLlevas *{variables.get('3', 'X.XX')} kWh* acumulados.\n\nTu proyección de pago es de *${variables.get('4', 'X.XX')}*."
        
    elif template_sid == CONTENT_SID_REPORTE_MENOS:
        return f"Hola {variables.get('1', 'usuario')}, tu consumo de ayer fue de *{variables.get('2', 'X.XX')} kWh* 👇 (más bajo que tu promedio).\nLlevas *{variables.get('3', 'X.XX')} kWh* acumulados.\n\nTu proyección de pago es de *${variables.get('4', 'X.XX')}*."
        
    elif template_sid == CONTENT_SID_RECORDATORIO_CONEXION:
        return f"Hola {variables.get('1', 'usuario')}, notamos que aún no has conectado tu dispositivo LETE. ¡Conéctalo para empezar a monitorear! 🔌"

    # --- Plantillas de vigilante_calidad.py (Incluidas para robustez) ---
    elif template_sid == TPL_FELICITACION_CONEXION:
        return f"¡Felicidades {variables.get('1', 'usuario')}! Tu dispositivo LETE se ha conectado por primera vez. 🎉\n\nYa estás monitoreando tu consumo."
    
    elif template_sid == TPL_PICOS_VOLTAJE:
        return f"Hola {variables.get('1', 'usuario')}, detectamos *{variables.get('2', 'varios')} picos de alto voltaje* en tu instalación. ⚡️\nTe recomendamos usar reguladores en aparatos sensibles."
    
    elif template_sid == TPL_BAJO_VOLTAJE:
        return f"Hola {variables.get('1', 'usuario')}, detectamos *voltaje bajo* en tu instalación. Esto puede dañar motores y compresores (ej. refrigerador). 📉"
        
    elif template_sid == TPL_FUGA_CORRIENTE:
        return f"Hola {variables.get('1', 'usuario')}, detectamos una posible *fuga de corriente*. ⚠️\nEsto puede aumentar tu recibo y es un riesgo. Te recomendamos contactar a un electricista."
        
    elif template_sid == TPL_BRINCO_ESCALON:
        return f"Hola {variables.get('1', 'usuario')}, has superado un escalón de CFE. 📈\nTu tarifa para el consumo excedente ahora es de *${variables.get('2', 'X.XX')} por kWh*."
        
    elif template_sid == TPL_CONSUMO_FANTASMA:
        return f"Hola {variables.get('1', 'usuario')}, detectamos un consumo inusual a las {variables.get('2', 'HH:MM')}. 👻\nTu consumo aumentó un *{variables.get('3', 'X')}%* comparado con tu promedio para esa hora."
        
    elif template_sid == TPL_DISPOSITIVO_OFFLINE:
        return f"ALERTA ADMIN: El dispositivo de *{variables.get('1', 'Cliente')}* está offline. 🚫"
        
    else:
        print(f"⚠️  ADVERTENCIA: Plantilla desconocida en formatear_mensaje_telegram: {template_sid}")
        return f"Alerta del sistema (SID: {template_sid}). Variables: {json.dumps(variables)}"

# --- ¡NUEVA FUNCIÓN DE DECISIÓN! ---
def enviar_alerta_dual(cliente_info, template_sid, variables):
    """
    Decide si enviar la alerta por WhatsApp o Telegram basándose en la
    preferencia del cliente.
    """
    # Desempaquetamos solo los campos que necesitamos para esta decisión
    telefono_whatsapp = cliente_info.get('telefono')
    telegram_chat_id = cliente_info.get('telegram_chat_id')
    prefiere_telegram = cliente_info.get('prefiere_telegram')
    
    if prefiere_telegram and telegram_chat_id:
        # --- Canal 1: Preferencia es TELEGRAM ---
        print(f"INFO: Cliente prefiere Telegram. Enviando a {telegram_chat_id}...")
        mensaje_telegram = formatear_mensaje_telegram(template_sid, variables)
        enviar_alerta_telegram(telegram_chat_id, mensaje_telegram)
        
    elif telefono_whatsapp:
        # --- Canal 2: Preferencia es WHATSAPP (o no ha configurado Telegram) ---
        print(f"INFO: Cliente prefiere WhatsApp (o es default). Enviando a {telefono_whatsapp}...")
        enviar_alerta_whatsapp(telefono_whatsapp, template_sid, variables)
        
    else:
        # --- Fallback: No tiene canal de contacto ---
        print(f"⚠️ ADVERTENCIA: Cliente sin 'telefono_whatsapp' ni 'telegram_chat_id' configurado. No se envió alerta.")

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

# --- 8. Lógica de Procesamiento de Clientes (MODIFICADA) ---
def _enviar_alerta_3_dias(cliente, proxima_fecha_de_corte):
    # Desempaquetado (15 campos)
    (device_id, telefono, telegram_chat_id, prefiere_telegram, _, 
     nombre, _, _, _, _, _, _, _, _, _) = cliente
    
    print("INFO: Enviando alerta de 3 días para el corte.")
    variables = {"1": nombre, "2": proxima_fecha_de_corte.strftime('%d de %B')}
    
    # Creamos un dict con la info del cliente para la función dual
    cliente_info = {
        "telefono": telefono,
        "telegram_chat_id": telegram_chat_id,
        "prefiere_telegram": prefiere_telegram
    }
    
    # ¡Llamamos a la nueva función!
    enviar_alerta_dual(cliente_info, CONTENT_SID_AVISO_CORTE_3DIAS, variables)
    
    marcar_notificacion_enviada(device_id, 'notificacion_corte_3dias')

def _enviar_alerta_dia_de_corte(cliente, ultima_corte, proxima_corte):
    # Desempaquetado (15 campos)
    (device_id, telefono, telegram_chat_id, prefiere_telegram, _, 
     nombre, _, tipo_tarifa, _, _, _, _, _, _, _) = cliente
    
    print("INFO: Enviando alerta de DÍA DE CORTE con resumen final.")
    
    inicio_periodo = ZONA_HORARIA_LOCAL.localize(datetime.combine(ultima_corte, datetime.min.time()))
    fin_periodo = ZONA_HORARIA_LOCAL.localize(datetime.combine(proxima_corte, datetime.min.time()))
    
    consumo_final, _ = obtener_consumo_desde_influxdb(device_id, inicio_periodo, fin_periodo)
    if consumo_final is None: consumo_final = 0.0
    
    costo_final = calcular_costo_estimado(consumo_final, tipo_tarifa)
    variables = {"1": nombre, "2": f"{consumo_final:.2f}", "3": f"{costo_final:.2f}"}
    
    cliente_info = {
        "telefono": telefono,
        "telegram_chat_id": telegram_chat_id,
        "prefiere_telegram": prefiere_telegram
    }
    
    # ¡Llamamos a la nueva función!
    enviar_alerta_dual(cliente_info, CONTENT_SID_DIA_DE_CORTE, variables)
    
    marcar_notificacion_enviada(device_id, 'notificacion_dia_corte')

def _generar_reporte_diario(cliente, hoy_aware, fechas_corte):
    # --- ¡DESEMPAQUETADO MODIFICADO! ---
    # Ahora recibimos 15 campos del tuple de cliente
    (device_id, telefono, telegram_chat_id, prefiere_telegram, kwh_promedio, nombre, _, tipo_tarifa, 
     fecha_inicio_servicio, _, _, _, 
     lectura_cierre, lectura_inicial, _) = cliente
     
    ultima_fecha_de_corte, proxima_fecha_de_corte = fechas_corte
    
    ayer_date = hoy_aware.date() - timedelta(days=1)
    inicio_ayer = ZONA_HORARIA_LOCAL.localize(datetime.combine(ayer_date, datetime.min.time()))
    fin_ayer = ZONA_HORARIA_LOCAL.localize(datetime.combine(hoy_aware.date(), datetime.min.time()))
    
    # --- ¡CAMBIO DE FUNCIÓN! ---
    kwh_ayer, _ = obtener_consumo_desde_influxdb(device_id, inicio_ayer, fin_ayer)
    
    if kwh_ayer is None: 
        print(f"INFO: No se encontraron datos de consumo de ayer para {nombre}. No se enviará reporte.")
        return

    # --- LÓGICA DE "PRIMER PERIODO" APLICADA AQUÍ ---
    
    # 1. Determinar desde cuándo medir en InfluxDB
    fecha_inicio_servicio_date = fecha_inicio_servicio.date() if isinstance(fecha_inicio_servicio, datetime) else fecha_inicio_servicio
    fecha_inicio_periodo_influx = ultima_fecha_de_corte
    
    if fecha_inicio_servicio_date and fecha_inicio_servicio_date > ultima_fecha_de_corte:
        fecha_inicio_periodo_influx = fecha_inicio_servicio_date
        print(f"   -> {nombre}: Cliente en primer periodo (instaló el {fecha_inicio_servicio_date}).")

    inicio_periodo_influx_aware = ZONA_HORARIA_LOCAL.localize(datetime.combine(fecha_inicio_periodo_influx, datetime.min.time()))
    
    # 2. Consultar el consumo medido por InfluxDB
    # (Se consulta desde el inicio del periodo EN INFLUX hasta el fin de ayer)
    kwh_medidos_influx, _ = obtener_consumo_desde_influxdb(device_id, inicio_periodo_influx_aware, fin_ayer)
    if kwh_medidos_influx is None: kwh_medidos_influx = 0.0

    # 3. Calcular el consumo "acarreado" (si aplica)
    kwh_acarreados = 0.0
    if (fecha_inicio_servicio_date and 
        fecha_inicio_servicio_date > ultima_fecha_de_corte and 
        lectura_inicial and 
        lectura_cierre):
        
        # El cliente está en su primer periodo Y se instaló después del corte.
        kwh_acarreados = float(lectura_inicial) - float(lectura_cierre)
        print(f"   -> {nombre}: Lógica de Primer Periodo. Acarreados: {kwh_acarreados:.2f} kWh")

    # 4. El consumo total del periodo es la suma de ambos
    kwh_periodo_actual = kwh_acarreados + kwh_medidos_influx
    print(f"   -> {nombre}: Consumo medido Influx: {kwh_medidos_influx:.2f} kWh. Total periodo: {kwh_periodo_actual:.2f} kWh")
    # --- FIN DE LÓGICA "PRIMER PERIODO" ---
        
    promedio_float = float(kwh_promedio) if kwh_promedio is not None else 0.0
    
    # Calculamos los días REALES transcurridos en el periodo del ciclo
    dias_transcurridos_ciclo = (ayer_date - ultima_fecha_de_corte).days + 1
    if dias_transcurridos_ciclo <= 0: 
        dias_transcurridos_ciclo = 1
    
    # --- LÓGICA DE SELECCIÓN DE PLANTILLA (CORREGIDA) ---
    if dias_transcurridos_ciclo < MIN_DIAS_PARA_PROYECCION:
        # PERIODO INICIAL: Sin proyección
        print(f"   -> {nombre}: Aún en periodo inicial (sin proyección). Días del ciclo: {dias_transcurridos_ciclo}")
        variables = {"1": nombre, "2": f"{kwh_ayer:.2f}", "3": f"{kwh_periodo_actual:.2f}"}
        template_sid = CONTENT_SID_REPORTE_INICIAL
        
    else:
        # CON PROYECCIÓN: Solo proyectamos el consumo medido, NO los acarreados
        dias_del_ciclo = (proxima_fecha_de_corte - ultima_fecha_de_corte).days
        if dias_del_ciclo <= 0: 
            dias_del_ciclo = 60  # Fallback
        
        # --- CORRECCIÓN CLAVE ---
        # Si el cliente instaló después del inicio del ciclo, ajustamos la proyección
        if fecha_inicio_servicio_date and fecha_inicio_servicio_date > ultima_fecha_de_corte:
            # Cliente en primer periodo: Proyectamos SOLO el consumo medido
            dias_con_medicion = (ayer_date - fecha_inicio_servicio_date).days + 1
            if dias_con_medicion <= 0: 
                dias_con_medicion = 1
            
            # Promedio REAL del cliente (sin acarreados)
            promedio_diario_real = kwh_medidos_influx / dias_con_medicion
            
            # Días restantes del ciclo (desde hoy hasta el corte)
            dias_restantes = (proxima_fecha_de_corte - hoy_aware.date()).days
            
            # Proyección = Acarreados + Consumo ya medido + Estimación de días restantes
            proyeccion_kwh = kwh_acarreados + kwh_medidos_influx + (promedio_diario_real * dias_restantes)
            
            print(f"   -> {nombre}: Primer Periodo. Promedio real: {promedio_diario_real:.2f} kWh/día")
            print(f"      Acarreados: {kwh_acarreados:.2f}, Medidos: {kwh_medidos_influx:.2f}, Proyección días restantes: {promedio_diario_real * dias_restantes:.2f}")
        else:
            # Cliente regular: Proyección simple proporcional
            promedio_diario = kwh_periodo_actual / dias_transcurridos_ciclo
            proyeccion_kwh = promedio_diario * dias_del_ciclo
            
            print(f"   -> {nombre}: Cliente regular. Promedio: {promedio_diario:.2f} kWh/día")
        
        costo_estimado = calcular_costo_estimado(proyeccion_kwh, tipo_tarifa)
        
        print(f"      Proyección total: {proyeccion_kwh:.2f} kWh -> ${costo_estimado:.2f}")
        
        variables = {
            "1": nombre, 
            "2": f"{kwh_ayer:.2f}", 
            "3": f"{kwh_periodo_actual:.2f}", 
            "4": f"{costo_estimado:.2f}"
        }
        
        if kwh_ayer > promedio_float:
            template_sid = CONTENT_SID_REPORTE_MAS
        else:
            template_sid = CONTENT_SID_REPORTE_MENOS
        # --- ¡NUEVA LÓGICA DE ENVÍO! ---
    # (Toda la lógica 'if/else' de arriba solo decide el 'template_sid' y las 'variables')
    cliente_info = {
        "telefono": telefono,
        "telegram_chat_id": telegram_chat_id,
        "prefiere_telegram": prefiere_telegram
    }    

    # ¡Llamamos a la nueva función!
    enviar_alerta_dual(cliente_info, template_sid, variables)

def _realizar_cierre_de_ciclo(cliente, fechas_corte):
    # Desempaquetado (AHORA 15 campos)
    (device_id, _, _, _, _, nombre, _, _, _, _, _, _, _, _, _) = cliente
    ultima_fecha_de_corte, proxima_fecha_de_corte = fechas_corte
    print(f"¡Fin de periodo para {nombre}! Realizando cierre...")
    
    inicio_bimestre = ZONA_HORARIA_LOCAL.localize(datetime.combine(ultima_fecha_de_corte, datetime.min.time()))
    fin_bimestre = ZONA_HORARIA_LOCAL.localize(datetime.combine(proxima_fecha_de_corte, datetime.min.time()))
    
    # --- ¡CAMBIO DE FUNCIÓN! ---
    consumo_total_bimestre, _ = obtener_consumo_desde_influxdb(device_id, inicio_bimestre, fin_bimestre)
    
    if consumo_total_bimestre is not None and consumo_total_bimestre > 0:
        dias_del_bimestre = (proxima_fecha_de_corte - ultima_fecha_de_corte).days
        if dias_del_bimestre > 0:
            nuevo_promedio = consumo_total_bimestre / dias_del_bimestre
            actualizar_promedio_cliente(device_id, nuevo_promedio)
    resetear_banderas_notificacion(device_id)

def procesar_un_cliente(cliente_data, hoy_aware):
    """Orquesta el procesamiento completo para un único cliente."""
    # --- ¡DESEMPAQUETADO MODIFICADO! ---
    # Leemos 15 campos
    (device_id, telefono, telegram_chat_id, prefiere_telegram, _, nombre, dia_de_corte, _, 
     fecha_inicio_servicio, ciclo_bimestral, notif_3dias_enviada, notif_corte_enviada, _, _, 
     primera_medicion_recibida) = cliente_data
     
    print(f"\n--- Procesando cliente: {nombre} ({device_id}) ---")

    # --- REGLA 0: AÚN NO HA CONECTADO EL DISPOSITIVO ---
    if not primera_medicion_recibida:
        # Verificamos que ha pasado al menos 1 día para no ser insistentes
        fecha_inicio_servicio_date = fecha_inicio_servicio.date() if isinstance(fecha_inicio_servicio, datetime) else fecha_inicio_servicio
        dias_desde_activacion = (hoy_aware.date() - fecha_inicio_servicio_date).days

        if dias_desde_activacion >= 1:
            print(f"INFO: {nombre} (activado hace {dias_desde_activacion} días) aún no conecta. Enviando recordatorio DIARIO.")

            # (Asegúrate de tener esta variable en .env)
            # CONTENT_SID_RECORDATORIO_CONEXION ya se cargó arriba
            variables = {"1": nombre}
            
            # Enviar usando la lógica dual
            cliente_info = {
                "telefono": telefono,
                "telegram_chat_id": telegram_chat_id,
                "prefiere_telegram": prefiere_telegram
            }
            enviar_alerta_dual(cliente_info, CONTENT_SID_RECORDATORIO_CONEXION, variables)
            
        # No marcamos ninguna bandera, se enviará de nuevo mañana

        # Como no hay mediciones, no podemos procesar nada más.
        print(f"INFO: {nombre} no tiene mediciones. Omitiendo reportes diarios.")
        return # Salir de la función para este cliente.
    # --- FIN DE REGLA 0 ---
    
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
         # Corrección: El "cierre" debe calcular el bimestre que acaba de terminar.
         # El 'ultima_corte' de hoy fue el 'proxima_corte' de ayer.
         # Necesitamos el 'ultima_corte' anterior.
         mes_anterior = ultima_corte.month - 2
         ano_anterior = ultima_corte.year
         if mes_anterior <= 0:
             mes_anterior += 12
             ano_anterior -= 1
         dia_anterior = min(dia_de_corte, calendar.monthrange(ano_anterior, mes_anterior)[1])
         inicio_periodo_cerrado = date(ano_anterior, mes_anterior, dia_anterior)
         
         _realizar_cierre_de_ciclo(cliente_data, (inicio_periodo_cerrado, ultima_corte))

    # REGLA 3: Faltan 3 días para el corte.
    if dias_restantes == 3 and not notif_3dias_enviada:
        _enviar_alerta_3_dias(cliente_data, proxima_corte)
        return # No se envía reporte diario hoy.
    
    # REGLA 4: Si no se cumplió ninguna regla anterior, se envía el reporte diario.
    # (Se pasa el cliente_data completo, que incluye los 14 campos)
    _generar_reporte_diario(cliente_data, hoy_aware, (ultima_corte, proxima_corte))

# --- 9. Ejecución Principal ---
def main():
    print("=" * 50)
    print(f"--- Iniciando Script de Reporte Diario v4.1 (con Telegram - CORREGIDO) ---")
    
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
            # cliente[4] es 'nombre' en el nuevo tuple
            nombre_cliente = cliente[4] if len(cliente) > 4 else "ID Desconocido"
            print(f"❌ ERROR INESPERADO al procesar '{nombre_cliente}'. Saltando. Error: {e}")

    print("\n--- Script de Reporte Diario v4.1 (CORREGIDO) completado. ---")
    print("=" * 50)

if __name__ == "__main__":
    main()