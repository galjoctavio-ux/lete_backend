# Importamos las librerías necesarias
from flask import Flask, request
import datetime
import os

# Creamos la aplicación del servidor
app = Flask(__name__)

# Definimos la ruta donde se recibirán los datos
@app.route('/datos', methods=['POST'])
def recibir_datos():
    # --- CORRECCIÓN: Obtenemos el device_id desde la URL ---
    # El ESP32 deberá hacer la petición a: http://<IP_servidor>:8000/datos?device=SU_ID_AQUI
    device_id = request.args.get('device')
    if not device_id:
        return "Error: Falta el parametro 'device' en la URL", 400

    payload_completo = request.data.decode('utf-8')
    timestamp_lote = datetime.datetime.now().isoformat()
    
    print(f"[{timestamp_lote}] Lote de datos recibido del dispositivo: {device_id}.")
    lineas = payload_completo.strip().split('\n')
    
    try:
        with open('mediciones.csv', 'a') as f:
            for linea in lineas:
                linea = linea.strip()
                if linea:
                    # --- CORRECCIÓN: Añadimos el device_id al inicio de la línea ---
                    f.write(f"{timestamp_lote},{device_id},{linea}\n")
                    
        print(f"Se guardaron {len(lineas)} mediciones del dispositivo {device_id}.")

    except Exception as e:
        print(f"!!! Error al guardar en el archivo: {e}")
        return "Error interno", 500

    return "Datos recibidos", 200

# Esta parte hace que el servidor se inicie
if __name__ == '__main__':
    if not os.path.exists('mediciones.csv'):
        with open('mediciones.csv', 'w') as f:
            # --- CORRECCIÓN: Añadimos la columna 'device_id' a la cabecera ---
            f.write("timestamp_servidor,device_id,vrms,irms_phase,irms_neutral,power,va,power_factor,leakage,temp_cpu,sequence,timestamp_dispositivo\n")
            
    app.run(host='0.0.0.0', port=8000, debug=True)