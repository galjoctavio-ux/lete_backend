import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import numpy as np

# --- 1. CONFIGURACIÓN ---
NOMBRE_ARCHIVO_CSV = 'influxdata_2025-11-08T09_29_08Z.csv'

# Ajusta el precio por kWh (pesos MXN) según tu recibo de CFE.
# (Este es un promedio, puede variar. Tarifa DAC es más alta)
PRECIO_KWH_MXN = 2.5 

# Umbral (en Watts) para detectar un "pico" de electrodoméstico.
# Ajusta esto si ves demasiados eventos pequeños.
UMBRAL_PICO_W = 300
# -------------------------


def clasificar_pico(watts):
    """Estima qué tipo de aparato podría ser basado en la potencia."""
    watts = round(watts)
    if watts > 2500:
        return f"{watts} W: Podría ser una regadera eléctrica, o varios aparatos potentes al mismo tiempo."
    elif watts > 1500:
        return f"{watts} W: Típico de un horno eléctrico, parrilla de inducción o aire acondicionado grande."
    elif watts > 800:
        return f"{watts} W: Común en microondas, cafeteras, tostadores, planchas o secadoras de pelo."
    elif watts > 300:
        return f"{watts} W: Sugiere un motor grande (lavadora, bomba de agua, licuadora)."
    elif watts > 100:
        return f"{watts} W: Probablemente el compresor del refrigerador o un ventilador."
    else:
        return f"{watts} W: Carga pequeña (TV, computadora)."

def analizar_consumo():
    try:
        print(f"Cargando {NOMBRE_ARCHIVO_CSV}...")
        df = pd.read_csv(NOMBRE_ARCHIVO_CSV, comment='#')
    except FileNotFoundError:
        print(f"--- ERROR ---")
        print(f"No se encontró el archivo '{NOMBRE_ARCHIVO_CSV}'.")
        print("Asegúrate de que el script y el CSV estén en la misma carpeta.")
        return
    except Exception as e:
        print(f"Ocurrió un error al leer el archivo: {e}")
        return

    print("Procesando datos (puede tardar unos segundos)...")
    
    # --- 2. LIMPIEZA Y PREPARACIÓN DE DATOS ---
    # Convertir columnas a numérico, manejando errores
    df['power'] = pd.to_numeric(df['power'], errors='coerce')
    df['power_factor'] = pd.to_numeric(df['power_factor'], errors='coerce')
    
    # Convertir tiempo y establecer como índice
    df['time'] = pd.to_datetime(df['time'], errors='coerce')
    df = df.dropna(subset=['time', 'power', 'power_factor'])
    df = df.set_index('time')
    
    if df.empty:
        print("No se encontraron datos válidos después de la limpieza. Revisa el archivo.")
        return

    # --- 3. CÁLCULO DE MÉTRICAS ---
    
    # --- A. Patrones Generales y Consumo ---
    consumo_promedio_w = df['power'].mean()
    consumo_maximo_w = df['power'].max()
    fecha_consumo_maximo = df['power'].idxmax()
    
    # Agrupar por hora del día (0-23) para encontrar patrones
    df_por_hora_dia = df.groupby(df.index.hour)['power'].mean()
    hora_pico_promedio = df_por_hora_dia.idxmax()
    hora_valle_promedio = df_por_hora_dia.idxmin()

    # --- B. Malos Hábitos (Consumo Base y Factor de Potencia) ---
    
    # B1. Consumo Base (Fantasma) - Promedio de la madrugada (2 AM - 4 AM)
    df_noche = df.between_time('02:00', '04:00')
    consumo_base_w = 0.0
    if not df_noche.empty:
        consumo_base_w = df_noche['power'].mean()
        costo_fantasma_mes = (consumo_base_w * 24 * 30.5 / 1000) * PRECIO_KWH_MXN
    else:
        # Si no hay datos de 2-4am, usamos el 5% más bajo
        consumo_base_w = df['power'].quantile(0.05)
        costo_fantasma_mes = (consumo_base_w * 24 * 30.5 / 1000) * PRECIO_KWH_MXN

    # B2. Factor de Potencia (solo de lecturas con consumo real)
    factor_potencia_promedio = df[df['power'] > 20]['power_factor'].mean() # Ignorar PF cuando la potencia es casi 0

    # --- C. Detección de Electrodomésticos (Picos) ---
    # Usamos 'diff()' para ver los "brincos" de consumo (aparatos encendiéndose)
    df['power_diff'] = df['power'].diff()
    
    # Filtramos picos por encima del umbral
    eventos_encendido = df[df['power_diff'] > UMBRAL_PICO_W].sort_values(by='power_diff', ascending=False)


    # --- 4. IMPRESIÓN DEL REPORTE EN TERMINAL ---
    
    print("\n" + "="*50)
    print("      REPORTE DE ANÁLISIS ENERGÉTICO (7 Días)")
    print("="*50 + "\n")

    print("--- 💡 1. RESUMEN GENERAL DEL HOGAR ---")
    print(f"  · Consumo Promedio:     {consumo_promedio_w:.2f} W")
    print(f"  · Pico Máximo de Consumo: {consumo_maximo_w:.2f} W (Registrado el {fecha_consumo_maximo})")

    print("\n--- 🚫 2. ANÁLISIS DE MALOS HÁBITOS Y AHORRO ---")
    print(f"  · Consumo Base (Fantasma): {consumo_base_w:.2f} W")
    print(f"    ↳ Esto es lo que tu casa consume 'sin usar nada' (standby, módems, etc.)")
    print(f"    ↳ Costo mensual estimado de esta carga fantasma: ${costo_fantasma_mes:.2f} MXN\n")
    
    print(f"  · Factor de Potencia Promedio: {factor_potencia_promedio:.2f}")
    if factor_potencia_promedio < 0.8:
        print("    ↳ ¡ALERTA! Este valor es muy bajo (Ideal > 0.9).")
        print("    ↳ Sugiere que tienes aparatos ineficientes o de mala calidad (cargadores, LEDs genéricos).")
    else:
        print("    ↳ ¡Bien! Tienes una buena eficiencia eléctrica (Ideal > 0.9).")


    print("\n--- 📈 3. PATRONES DE CONSUMO DIARIO ---")
    print(f"  · Hora 'Pico' Promedio: {hora_pico_promedio}:00 hrs")
    print(f"    ↳ Es la hora del día en la que, en promedio, más energía consumes.")
    print(f"  · Hora 'Valle' Promedio: {hora_valle_promedio}:00 hrs")
    print(f"    ↳ Es la hora del día con menor consumo (usualmente la madrugada).")

    print("\n--- 🔌 4. DETECCIÓN DE ELECTRODOMÉSTICOS (Top 5 Picos) ---")
    print(f"   (Basado en aumentos repentinos de más de {UMBRAL_PICO_W} W)\n")
    
    if eventos_encendido.empty:
        print("  No se detectaron picos grandes. Posiblemente tu consumo es muy estable o el umbral es muy alto.")
    else:
        for i, (timestamp, row) in enumerate(eventos_encendido.head(5).iterrows()):
            pico_watts = row['power_diff']
            clasificacion = clasificar_pico(pico_watts)
            print(f"  {i+1}. {timestamp.strftime('%Y-%m-%d %H:%M:%S')}")
            print(f"     ↳ Se detectó un encendido de +{pico_watts:.0f} W.")
            print(f"     ↳ Clasificación: {clasificacion}\n")


    # --- 5. GENERACIÓN DE GRÁFICA ---
    print("Generando gráfica (analisis_consumo_7dias.png)...")
    
    # Agrupamos por hora para la gráfica principal
    df_grafica = df['power'].resample('H').mean()
    
    plt.figure(figsize=(15, 8))
    
    # Graficar el consumo por hora
    df_grafica.plot(color='blue', label='Consumo Promedio por Hora (W)', zorder=2)
    
    # Añadir una línea horizontal para el Consumo Base
    plt.axhline(y=consumo_base_w, color='red', linestyle='--', 
                label=f'Consumo Base (Fantasma): {consumo_base_w:.0f} W', zorder=3)
    
    # Añadir marcadores para los picos máximos detectados
    # Tomamos los 5 picos MÁS ALTOS (no los 'diff' más altos)
    top_picos_absolutos = df['power'].nlargest(5)
    plt.scatter(top_picos_absolutos.index, top_picos_absolutos.values, 
                color='orange', s=100, zorder=4, label='Picos Máximos Absolutos')
    
    # --- Estilo de la Gráfica ---
    plt.title('Análisis de Consumo Eléctrico - 7 Días', fontsize=16)
    plt.ylabel('Potencia (Watts)', fontsize=12)
    plt.xlabel('Fecha y Hora', fontsize=12)
    plt.grid(True, linestyle='--', alpha=0.6)
    plt.legend(loc='upper left')
    plt.tight_layout()
    ax = plt.gca()
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m-%d %H:%M'))
    plt.xticks(rotation=30)
    
    # Guardar y Mostrar
    plt.savefig('analisis_consumo_7dias.png', dpi=150)
    print("\n¡Análisis completo! Gráfica guardada y reporte impreso.")
    plt.show()

# --- Ejecutar el análisis ---
if __name__ == "__main__":
    analizar_consumo()