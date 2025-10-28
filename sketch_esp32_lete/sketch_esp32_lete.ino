/*
==========================================================================
== FIRMWARE LETE - MONITOR DE ENERGÍA v12.4 (Estable)
==
== CORRECCIONES v12.1:
== -
=========================================================================
*/

// --- 1. LIBRERÍAS ---
#include <WiFi.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include <DNSServer.h>
#include <WiFiManager.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <ArduinoJson.h>
#include "time.h"
#include "secrets.h"
#include <esp_task_wdt.h>
#include "EmonLib.h" // <-- LIBRERÍA AÑADIDA
#include <WiFiClientSecure.h> // <-- ASEGÚRATE DE TENER ESTO
#include <PubSubClient.h>

// --- LIBRERÍAS PARA HARDWARE ---
#include <SPI.h>
#include <SD.h>
#include <Adafruit_NeoPixel.h>

// --- 2. CONFIGURACIÓN PRINCIPAL ---
const float FIRMWARE_VERSION = 12.4;
const bool OLED_CONECTADA = true;
const bool DEBUG_MODE = false;

// --- CONFIGURACIÓN DE PINES ---
#define BUTTON_PIN 13
#define SD_CS_PIN 5
#define NEOPIXEL_PIN 4
#define NUM_PIXELS 4
#define I2C_SDA_PIN 21
#define I2C_SCL_PIN 22
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1

// --- PINES PARA MEDICIÓN CON ADC INTERNO ---
#define VOLTAGE_PIN 34
#define CURRENT_PHASE_PIN 32
#define CURRENT_NEUTRAL_PIN 35

// --- INTERVALOS DE TIEMPO Y CONTROL ---
const unsigned long MEASUREMENT_INTERVAL_MS = 2000;
const unsigned long SCREEN_CONSUMPTION_INTERVAL_MS = 30000;
const unsigned long SCREEN_OTHER_INTERVAL_MS = 15000;
//const unsigned long DAILY_RESTART_INTERVAL_MS = 24 * 3600 * 1000UL;
const unsigned long WIFI_CHECK_INTERVAL_MS = 30000;
const unsigned long NTP_RETRY_INTERVAL_MS = 120 * 1000;
const unsigned long SERVER_CHECK_INTERVAL_MS = 4 * 3600 * 1000UL;
const unsigned long MESSENGER_CYCLE_DELAY_MS = 5000;
#define WDT_TIMEOUT_SECONDS 180
#define LONG_PRESS_DURATION_MS 10000
//unsigned long bootTime = 0;

// --- CONFIGURACIÓN DE RED Y SENSORES ---
const char* NTP_SERVER_1 = "pool.ntp.org";
const char* NTP_SERVER_2 = "mx.pool.ntp.org";
const char* NTP_SERVER_3 = "time.google.com";
#define CONNECTION_TIMEOUT_MS 10000

// --- 3. OBJETOS Y VARIABLES GLOBALES ---

// Objetos de Hardware
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
Adafruit_NeoPixel pixels(NUM_PIXELS, NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);
EnergyMonitor emon_phase;
EnergyMonitor emon_neutral;

// Estructura de Datos para las Mediciones (Completa)
struct MeasurementData {
    uint32_t sequence_number;
    uint32_t timestamp;
    float vrms, irms_phase, irms_neutral, power, leakage, temp_cpu;
    float va, power_factor; // Campos para Potencia Aparente (VA) y Factor de Potencia
};

// Variables de Calibración para EmonLib
float voltage_cal = 153.5;
float current_cal_phase = 106.0;
float current_cal_neutral = 106.0;
float phase_cal = 1.7; // Factor de corrección de fase para EmonLib

// Variables de Estado (Protegidas por Mutex y Completas)
SemaphoreHandle_t sharedVarsMutex;
float latest_vrms = 0.0, latest_irms_phase = 0.0, latest_irms_neutral = 0.0;
float latest_power = 0.0, latest_leakage = 0.0, latest_temp_cpu = 0.0;
bool server_status = false;
bool subscription_active = false;
bool pago_vencido = false;
int dias_de_gracia_restantes = 0;
String sub_next_payment_str = "--/--/----";
long sub_active_until_ts = 0;
bool time_synced = false;

// Variables para la arquitectura de "Batching"
const int BATCH_SIZE = 10; // Número de mediciones por archivo
int lines_in_buffer = 0;   // Contador de líneas en el buffer actual

// Otras Variables de Control
TaskHandle_t writerTaskHandle;
TaskHandle_t messengerTaskHandle;
volatile bool ota_update_request = false; // <-- AÑADE ESTA LÍNEA
int screen_mode = 0;
unsigned long last_screen_change_time = 0;
unsigned long last_wifi_check = 0;
unsigned long button_press_start_time = 0;
bool button_is_pressed = false;
uint32_t global_sequence_number = 0;
String currentServerUrl; //Se agrega
const int MQTT_PORT = 1883;
const char* TOPIC_BOOT = "lete/dispositivos/boot_time";
const char* TOPIC_MEDICIONES = "lete/mediciones/"; // El device_id se añadirá al final

// Objetos de WiFi y MQTT
WiFiClient espClient;
PubSubClient client(espClient);

// Variables de estado para MQTT
String deviceIdForMqtt = "";
bool boot_time_reported = false;
volatile bool calibration_complete = false;

// --- 4. DECLARACIÓN DE FUNCIONES ---
void writerTask(void * pvParameters);
void messengerTask(void * pvParameters);
void checkSubscriptionStatus();
void loadCalibration();
void saveCalibration();
void handleFactoryReset();

// --- INCLUSIÓN DE ARCHIVOS SEPARADOS ---
#include "oled_screens.h"

// =========================================================================
// === TAREA 1: ESCRITOR (NÚCLEO 1) - VERSIÓN MODIFICADA (FASE 1)        ===
// =========================================================================
void writerTask(void * pvParameters) {
    if(DEBUG_MODE) Serial.println("[N1] Tarea de Escritura iniciada en Núcleo 1.");
    esp_task_wdt_add(NULL);
    
    // --- PASO 3: AÑADIR RETRASO DE ESTABILIZACIÓN ---
    if(DEBUG_MODE) Serial.println("[N1] Esperando 60 segundos para estabilización de sensores...");
    vTaskDelay(pdMS_TO_TICKS(60000));
    if(DEBUG_MODE) Serial.println("[N1] Estabilización completa. Iniciando bucle principal.");

    // ¡¡SOLUCIÓN AQUÍ!!
    // Ahora, esperar a que el Núcleo 0 (setup) termine la calibración.
    if(DEBUG_MODE) Serial.println("[N1] Esperando a que el Núcleo 0 termine la calibración...");
    while (!calibration_complete) {
        vTaskDelay(pdMS_TO_TICKS(200)); // Esperar 200ms y volver a checar
    }
    if(DEBUG_MODE) Serial.println("[N1] ¡Calibración confirmada! Iniciando bucle principal.");

    unsigned long last_measurement_time = 0;
    const int lecturas_a_descartar = 5;
    int lecturas_descartadas = 0;
    
    for (;;) { // <-- INICIO DEL BUCLE INFINITO PRINCIPAL
        esp_task_wdt_reset();
        unsigned long currentMillis = millis();

        if (currentMillis - last_measurement_time >= MEASUREMENT_INTERVAL_MS) {
            last_measurement_time = currentMillis;
            if(DEBUG_MODE) Serial.println("\n[N1] ==> Iniciando ciclo de medición...");

            // Realizamos los cálculos para el canal de Fase (que incluye voltaje)
            emon_phase.calcVI(20, 2000);
            // Realizamos los cálculos solo para la corriente del Neutro
            emon_neutral.calcVI(20, 2000);

            if (lecturas_descartadas < lecturas_a_descartar) {
                lecturas_descartadas++;
                if(DEBUG_MODE) Serial.printf("[N1] Descartando lectura inicial %d de %d.\n", lecturas_descartadas, lecturas_a_descartar);
            } else {
                
                // --- PASO 4: ELIMINADO EL BLOQUEO 'if (!time_synced)' ---
                // El código ahora continúa midiendo y guardando incondicionalmente.
            
                if(DEBUG_MODE && lecturas_descartadas == 5) Serial.println("[N1] Lecturas iniciales descartadas. Empezando a procesar datos.");
                
                MeasurementData data;
                data.sequence_number = ++global_sequence_number;
                // --- PASO 5: USAR millis() COMO TIMESTAMP ---
                data.timestamp = millis(); 
                data.vrms = emon_phase.Vrms;
                data.irms_phase = emon_phase.Irms;
                data.irms_neutral = emon_neutral.Irms;
                data.power = emon_phase.realPower;
                data.va = emon_phase.apparentPower;
                data.power_factor = emon_phase.powerFactor;
                data.leakage = fabs(data.irms_phase - data.irms_neutral);
                data.temp_cpu = temperatureRead();

                if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                    latest_vrms = data.vrms;
                    latest_irms_phase = data.irms_phase;
                    latest_irms_neutral = data.irms_neutral;
                    latest_power = data.power;
                    latest_leakage = data.leakage;
                    latest_temp_cpu = data.temp_cpu;
                    xSemaphoreGive(sharedVarsMutex);
                }

                // --- IMPRESIÓN DE CALIBRACIÓN ---
                Serial.printf("[N1] RMS -> V:%.1f, A_Fase:%.3f, A_Neutro:%.3f, W:%.0f, VA:%.0f, FP:%.2f, Fuga:%.3f, Temp:%.1fC\n",
                              data.vrms, data.irms_phase, data.irms_neutral, data.power, data.va, data.power_factor, data.leakage, data.temp_cpu);
                
                // --- PASO 4: ELIMINADA LA CONDICIÓN 'if (time_synced)' ---
                // La lógica de guardado en SD ahora se ejecuta siempre.
                
                if(DEBUG_MODE) Serial.println("[N1-Debug] Procediendo a guardar en SD.");
                File dataFile = SD.open("/buffer.dat", FILE_APPEND);
                if (dataFile) {
                    // --- PASO 6: AJUSTAR FORMATO DE GUARDADO (Automático por Paso 5) ---
                    // Se mantiene el formato de 10 campos, pero data.timestamp ahora contiene millis().
                    // Esto coincide con el sscanf existente en messengerTask
                    dataFile.print(data.sequence_number);
                    dataFile.print(",");
                    dataFile.print(data.timestamp); dataFile.print(",");
                    dataFile.print(data.vrms); dataFile.print(",");
                    dataFile.print(data.irms_phase); dataFile.print(",");
                    dataFile.print(data.irms_neutral); dataFile.print(",");
                    dataFile.print(data.power); dataFile.print(",");
                    dataFile.print(data.va); dataFile.print(",");
                    dataFile.print(data.power_factor); dataFile.print(",");
                    dataFile.print(data.leakage);
                    dataFile.print(",");
                    dataFile.println(data.temp_cpu);
                    dataFile.close();

                    lines_in_buffer++;
                    if(DEBUG_MODE) Serial.printf("[N1] Agregando linea %d/%d al buffer.\n", lines_in_buffer, BATCH_SIZE);
                    
                    if (lines_in_buffer >= BATCH_SIZE) {
                        // El nombre del archivo ahora usará el timestamp de millis() de la última medición
                        String new_filename = "/" + String(data.timestamp) + ".dat";
                        if (SD.rename("/buffer.dat", new_filename)) {
                            if(DEBUG_MODE) Serial.printf("[N1] Batch completo. Archivo '/buffer.dat' renombrado a '%s'\n", new_filename.c_str());
                        } else {
                            if(DEBUG_MODE) Serial.println("[N1] ERROR: Fallo al renombrar el buffer.");
                        }
                        lines_in_buffer = 0;
                    }
                } else {
                    if(DEBUG_MODE) Serial.println("[N1] ERROR: Fallo al abrir /buffer.dat para añadir.");
                }
            }
        } // Fin de if (measurement interval)
        
        // --- GESTIÓN DE BOTÓN Y PANTALLA (SIN CAMBIOS) ---
        if (digitalRead(BUTTON_PIN) == LOW) {
            if (!button_is_pressed) {
                button_press_start_time = currentMillis;
                button_is_pressed = true;
            } else if (currentMillis - button_press_start_time > LONG_PRESS_DURATION_MS) {
                drawGenericMessage("Borrando WiFi", "Reiniciando...");
                pixels.setPixelColor(0, pixels.Color(255, 0, 255)); pixels.show();
                WiFiManager wm;
                wm.resetSettings();
                delay(2000);
                ESP.restart();
            }
        } else {
            if (button_is_pressed) {
                if(currentMillis - button_press_start_time < 2000) {
                    screen_mode = (screen_mode + 1) % 4;
                    last_screen_change_time = currentMillis;
                }
            }
            button_is_pressed = false;
        }

        if (OLED_CONECTADA) {
            unsigned long rotation_interval = (screen_mode == 0) ?
                SCREEN_CONSUMPTION_INTERVAL_MS : SCREEN_OTHER_INTERVAL_MS;
            if (currentMillis - last_screen_change_time > rotation_interval) {
                screen_mode = (screen_mode + 1) % 3;
                last_screen_change_time = currentMillis;
            }
            
            bool pago_vencido_local;
            if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                pago_vencido_local = pago_vencido;
                xSemaphoreGive(sharedVarsMutex);
            }

            if(pago_vencido_local) {
                drawPaymentDueScreen();
            } else {
                switch (screen_mode) {
                    case 0: drawConsumptionScreen(); break;
                    case 1: drawDiagnosticsScreen(); break;
                    case 2: drawServiceScreen(); break;
                }
            }
        }
        
        // --- TAREAS DE MANTENIMIENTO DEL SISTEMA (SIN CAMBIOS) ---
        if (currentMillis - last_wifi_check > WIFI_CHECK_INTERVAL_MS) {
            last_wifi_check = currentMillis;
            if (WiFi.status() != WL_CONNECTED) {
                if(DEBUG_MODE) Serial.println("[N1] WiFi desconectado, intentando reconectar...");
                WiFi.reconnect();
            }
        }

        // --- PASO 1: ELIMINADO REINICIO DIARIO ---
        // El bloque 'if (currentMillis - bootTime > DAILY_RESTART_INTERVAL_MS)' se ha eliminado.

        vTaskDelay(pdMS_TO_TICKS(50));
    } // <-- FIN DEL BUCLE INFINITO PRINCIPAL
}

// =========================================================================
// === TAREA 2: MENSAJERO (NÚCLEO 0) - CON MQTT (FASE 3) ===================
// =========================================================================
void messengerTask(void * pvParameters) {
    if(DEBUG_MODE) Serial.println("[N0] Tarea de Mensajero iniciada en Núcleo 0.");
    esp_task_wdt_add(NULL);
    
    unsigned long last_server_check = 0;
    unsigned long last_ntp_attempt = 0;

    for (;;) {
        if(DEBUG_MODE) Serial.println("\n[N0-Debug] >>> Inicio del bucle de la tarea Messenger.");
        esp_task_wdt_reset();

        // --- MANEJO DE ACTUALIZACIÓN OTA MANUAL (Se mantiene) ---
        bool update_requested_local = false;
        if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
            if (ota_update_request) {
                update_requested_local = true;
                ota_update_request = false;
            }
            xSemaphoreGive(sharedVarsMutex);
        }
        if (update_requested_local) {
            if (DEBUG_MODE) Serial.println("[N0] Petición de actualización manual detectada. Ejecutando checkForHttpUpdate()...");
            checkForHttpUpdate();
        }
        if(DEBUG_MODE) Serial.println("[N0-Debug] Chequeo de OTA manual finalizado.");

        // --- GESTIÓN DE WIFI (Se mantiene) ---
        if (WiFi.status() != WL_CONNECTED) {
            if(DEBUG_MODE) Serial.println("[N0] WiFi desconectado, en espera durante 10s...");
            pixels.setPixelColor(0, pixels.Color(255, 165, 0));
            pixels.show();
            vTaskDelay(pdMS_TO_TICKS(10000));
            continue;
        }
        
        pixels.setPixelColor(0, pixels.Color(0, 0, (millis() % 2000) < 1000 ? 50 : 0));
        pixels.show();

         // --- TAREAS PERIÓDICAS (OTA y Comandos Supabase - Se mantienen) ---
        if (millis() - last_server_check > SERVER_CHECK_INTERVAL_MS || last_server_check == 0) {
            if(DEBUG_MODE) Serial.println("[N0-Debug] Condición para chequear servidor cumplida. Llamando a handleRemoteTasks().");
            bool newConfig = handleRemoteTasks();
            if (newConfig) {
                if (DEBUG_MODE) Serial.println("[N0] Nueva configuración remota detectada, guardando en SD...");
                saveCalibration();
            }

            checkForHttpUpdate();
            
            last_server_check = millis();
        }


        // --- FASE 3: LÓGICA DE CONEXIÓN MQTT ---
        if (!client.connected()) {
            if (DEBUG_MODE) Serial.println("[N0] Intentando conexión MQTT...");
            
            // Generar el ID de dispositivo una vez
            if (deviceIdForMqtt == "") {
                deviceIdForMqtt = WiFi.macAddress();
                deviceIdForMqtt.replace(":", "");
            }

            if (client.connect(deviceIdForMqtt.c_str(), MQTT_USER, MQTT_PASSWORD)) {
                if (DEBUG_MODE) Serial.println("[N0] MQTT Conectado.");
            } else {
                if (DEBUG_MODE) Serial.printf("[N0] ERROR: Fallo al conectar a MQTT, rc=%d. Reintentando en 5s...\n", client.state());
                vTaskDelay(pdMS_TO_TICKS(5000));
                continue; // Reinicia el bucle para reintentar la conexión
            }
        }
        client.loop(); // Maneja los callbacks y pings de MQTT

        // --- GESTIÓN DE HORA (NTP) Y REPORTE DE ARRANQUE (TAREA A) ---
        if (!time_synced && millis() - last_ntp_attempt > NTP_RETRY_INTERVAL_MS) {
            last_ntp_attempt = millis();
            if(DEBUG_MODE) Serial.println("[N0] ==> Intentando sincronizar NTP...");
            configTime(0, 0, NTP_SERVER_1, NTP_SERVER_2, NTP_SERVER_3);
            struct tm timeinfo;
            if (getLocalTime(&timeinfo, 5000)) {
                if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                    time_synced = true;
                    xSemaphoreGive(sharedVarsMutex);
                    if(DEBUG_MODE) Serial.println("[N0-Debug] Flag 'time_synced' puesto en true.");
                }
                if(DEBUG_MODE) Serial.println("[N0] Hora NTP sincronizada con éxito.");

                // --- FASE 3: IMPLEMENTAR REPORTE DE ARRANQUE (TAREA A) ---
                if (!boot_time_reported && client.connected()) {
                    long boot_time_unix = time(NULL) - (millis() / 1000);
                    char jsonPayload[128];
                    
                    snprintf(jsonPayload, sizeof(jsonPayload), 
                             "{\"device_id\":\"%s\",\"boot_time_unix\":%lu}", 
                             deviceIdForMqtt.c_str(), boot_time_unix);
                    
                    // Publicar con retención (true) para que el backend la reciba
                    if (client.publish(TOPIC_BOOT, jsonPayload, true)) { 
                        if(DEBUG_MODE) Serial.printf("[N0] ÉXITO: Reporte de arranque enviado: %s\n", jsonPayload);
                        boot_time_reported = true;
                    } else {
                        if(DEBUG_MODE) Serial.println("[N0] ERROR: Fallo al enviar reporte de arranque.");
                    }
                }
                // --- FIN FASE 3 ---

            } else {
                if(DEBUG_MODE) Serial.println("[N0] ERROR: Fallo al obtener hora NTP (timeout).");
            }
        }
        if(DEBUG_MODE) Serial.println("[N0-Debug] Chequeo de NTP finalizado.");

       
        if(DEBUG_MODE) Serial.println("[N0-Debug] Chequeo de tareas periódicas finalizado.");

        // --- FASE 3: PROCESAMIENTO DE ARCHIVOS DE LA SD CON MQTT (TAREA B) ---
        if (boot_time_reported) {
        if(DEBUG_MODE) Serial.println("[N0-Debug] Abriendo directorio raíz de la SD para buscar archivos...");
        File root = SD.open("/");
        if (!root) {
            if(DEBUG_MODE) Serial.println("[N0] ERROR CRÍTICO: No se pudo abrir el directorio raíz de la SD.");
            pixels.setPixelColor(0, pixels.Color(255, 0, 0)); pixels.show();
            vTaskDelay(pdMS_TO_TICKS(5000));
            continue;
        }

        File file_to_process;
        while(file_to_process = root.openNextFile()){
            String filename = file_to_process.name();
            if (filename.endsWith(".dat") && filename != "/buffer.dat") {
                if(DEBUG_MODE) Serial.printf("\n[N0] ==> Archivo de batch encontrado: %s (Tamaño: %d bytes)\n", filename.c_str(), file_to_process.size());

                // --- Lógica de suscripción (se mantiene) ---
                bool puede_enviar_datos = false;
                if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                    if (subscription_active || dias_de_gracia_restantes > 0) {
                        puede_enviar_datos = true;
                    }
                    xSemaphoreGive(sharedVarsMutex);
                }

                if (!puede_enviar_datos) {
                    if(DEBUG_MODE) Serial.printf("[N0] Suscripción inactiva. Omitiendo envío del batch %s.\n", filename.c_str());
                    file_to_process.close();
                    continue; // Pasa al siguiente archivo
                }

                // --- Procesar y enviar por MQTT línea por línea ---
                bool batch_success = true;
                String topic_mediciones = String(TOPIC_MEDICIONES) + deviceIdForMqtt;

                while (file_to_process.available()) {
                    String line = file_to_process.readStringUntil('\n');
                    line.trim();
                    if (line.length() > 0) {
                        MeasurementData data;
                        // El sscanf sigue parseando 10 campos
                        // data.timestamp ahora contiene millis()
                        int parsed_items = sscanf(line.c_str(), "%u,%lu,%f,%f,%f,%f,%f,%f,%f,%f", 
                                          &data.sequence_number, &data.timestamp, &data.vrms, &data.irms_phase, 
                                          &data.irms_neutral, &data.power, &data.va, &data.power_factor, &data.leakage, &data.temp_cpu);
                        
                        if (parsed_items == 10) {
                            char jsonPayload[256];
                            // Construir el JSON con nombres cortos para ahorrar espacio
                            snprintf(jsonPayload, sizeof(jsonPayload),
                                     "{\"ts_millis\":%lu,\"vrms\":%.2f,\"irms_p\":%.3f,\"irms_n\":%.3f,\"pwr\":%.2f,\"va\":%.2f,\"pf\":%.2f,\"leak\":%.3f,\"temp\":%.1f,\"seq\":%u}",
                                     data.timestamp, data.vrms, data.irms_phase, data.irms_neutral, data.power, data.va, data.power_factor, data.leakage, data.temp_cpu, data.sequence_number);
                            
                            // Publicar el mensaje
                            if (!client.publish(topic_mediciones.c_str(), jsonPayload)) {
                                if(DEBUG_MODE) Serial.println("[N0] ERROR: Fallo al publicar mensaje MQTT. Abortando este batch.");
                                batch_success = false;
                                break; // Rompe el bucle 'while (file_to_process.available())'
                            } else {
                                 if(DEBUG_MODE) Serial.printf("[N0] Mensaje enviado: %s\n", jsonPayload);
                            }
                        } else {
                            if(DEBUG_MODE) Serial.printf("[N0] ADVERTENCIA: Línea mal formada en %s, %d/10. Ignorada.\n", filename.c_str(), parsed_items);
                        }
                    }

                    // --- INICIO DE LA CORRECCIÓN DE TIMEOUT ---
                client.loop(); // Permite que MQTT envíe pings de keep-alive
                esp_task_wdt_reset(); // Evita el reinicio del Watchdog
                // --- FIN DE LA CORRECCIÓN ---
                } // Fin del bucle while (file_to_process.available())

                if (batch_success) {
                    if(DEBUG_MODE) Serial.printf("[N0] ÉXITO: Batch %s enviado. Borrando archivo.\n", filename.c_str());
                    // Cerramos el archivo ANTES de borrarlo
                    file_to_process.close();
                    SD.remove("/" + filename);
                } else {
                    if(DEBUG_MODE) Serial.printf("[N0] ERROR: Batch %s fallido. Se reintentará.\n", filename.c_str());
                    // Cerramos el archivo y rompemos el bucle principal para reintentar
                    file_to_process.close();
                    break; 
                }

            } else {
                 if(DEBUG_MODE && filename != "/") Serial.printf("[N0-Debug] Archivo/Directorio encontrado ('%s') pero ignorado.\n", filename.c_str());
            }
            
            if (file_to_process) {
                file_to_process.close();
            }
            
            esp_task_wdt_reset();
        }
        root.close();
        if(DEBUG_MODE) Serial.println("[N0-Debug] Búsqueda de archivos finalizada para este ciclo.");

        } else {
    // Si aún no se reporta, solo imprime un aviso y espera al siguiente ciclo
    if(DEBUG_MODE) Serial.println("[N0-Debug] Esperando reporte de arranque antes de procesar archivos SD.");
    }
    // ¡¡FIN DE LA SOLUCIÓN 1!!

        ArduinoOTA.handle();
        if(DEBUG_MODE) Serial.printf("[N0-Debug] <<< Fin del bucle. Esperando %lu ms.\n", MESSENGER_CYCLE_DELAY_MS);
        vTaskDelay(pdMS_TO_TICKS(MESSENGER_CYCLE_DELAY_MS));
    }
}

// =========================================================================
// === SETUP (VERSIÓN FINAL CON LÓGICA DE CALIBRACIÓN INTEGRADA) =========
// =========================================================================
void setup() {
    Serial.begin(115200);
    delay(1000);
    Serial.println("\n\n==================================================");
    Serial.println("== INICIANDO FIRMWARE LETE v11.0 (EmonLib) ==");
    Serial.println("==================================================");
    //bootTime = millis();

    // --- 1. INICIALIZAR HARDWARE BÁSICO ---
    Serial.print("Inicializando hardware básico...");
    pinMode(BUTTON_PIN, INPUT_PULLUP); 
    pixels.begin();
    pixels.setBrightness(30);
    pixels.show();
    Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
    Serial.println(" OK.");

    // --- 3. INICIALIZAR PANTALLA ---
    // Se mueve aquí para mostrar el estado de carga desde el inicio
    Serial.print("Inicializando periféricos I2C (OLED)...");
    setupOLED();
    Serial.println(" OK.");
    
    // --- FASE 2: Implementar Pantalla de Arranque ---
    drawBootScreen("Iniciando..."); // <--- NUEVA PANTALLA DE ARRANQUE
    delay(500);

    // --- 2. INICIALIZAR TARJETA SD ---
    Serial.print("Montando tarjeta SD...");
    drawBootScreen("Montando SD..."); // <--- NUEVA PANTALLA DE ARRANQUE
    
    if (!SD.begin(SD_CS_PIN)) {
        Serial.println("\nERROR CRÍTICO: Fallo al montar la tarjeta SD. El sistema se detendrá.");
        pixels.setPixelColor(0, pixels.Color(255, 0, 0)); pixels.show();
        drawBootScreen("ERROR: SD"); // <--- NUEVA PANTALLA DE ARRANQUE
        while (1) delay(1000);
    }
    Serial.println(" OK.");
    
    // --- FASE 1: PURGAR DATOS ANTIGUOS AL ARRANCAR ---
    Serial.print("Purgando archivos de datos (.dat) de sesiones anteriores...");
    drawBootScreen("Purgando datos..."); // <--- NUEVA PANTALLA DE ARRANQUE
    
    File root = SD.open("/");
    if (root) {
        File file = root.openNextFile();
        while(file){
            String filename = file.name();
            // Borramos solo los archivos que nos interesan
            if (filename.endsWith(".dat")) {
                if(DEBUG_MODE) Serial.printf("\n[SETUP-Debug] Borrando archivo anterior: %s\n", filename.c_str());
                String fullPath = "/" + filename;
                SD.remove(fullPath);
            }
            file.close();
            file = root.openNextFile();
        }
        root.close();
        
        // Asegurarse de que el buffer residual también se borre
        if (SD.exists("/buffer.dat")) {
            SD.remove("/buffer.dat");
        }
        
    } else {
        Serial.println("ERROR: No se pudo abrir el directorio raíz para purgar.");
    }
    Serial.println(" OK.");
    

    // --- 6. INICIALIZAR MUTEX Y WATCHDOG ---
    Serial.print("Configurando sistema multitarea (Mutex y Watchdog)...");
    sharedVarsMutex = xSemaphoreCreateMutex();
    esp_task_wdt_config_t wdt_config = {
        .timeout_ms = WDT_TIMEOUT_SECONDS * 1000,
        .idle_core_mask = (1 << portNUM_PROCESSORS) - 1,
        .trigger_panic = true,
       };
    esp_task_wdt_reconfigure(&wdt_config);
    Serial.println(" OK.");

    // --- 4. CONFIGURAR EMONLIB ---
    Serial.print("Configurando EmonLib con pines y calibración...");
    emon_phase.voltage(VOLTAGE_PIN, voltage_cal, phase_cal);
    emon_phase.current(CURRENT_PHASE_PIN, current_cal_phase);
    emon_neutral.current(CURRENT_NEUTRAL_PIN, current_cal_neutral);
    Serial.println(" OK.");

    

    // --- 4. GESTIÓN DE WIFI CON WIFIMANAGER (LÓGICA CORREGIDA) ---
    Serial.println("Iniciando gestor de WiFi...");
    drawBootScreen("Conectando WiFi...");

    WiFi.mode(WIFI_STA); // Asegurarse de que estamos en modo estación
    // Comprobar si hay credenciales guardadas
    if (WiFi.SSID() == "") {
    // CASO 1: NO HAY CREDENCIALES (PRIMER ARRANQUE)
    // Iniciar portal de configuración
    Serial.println("No hay credenciales WiFi. Se iniciará el portal de configuración.");
    drawGenericMessage("Configuracion WiFi", "Conectate a la red: LETE-Monitor-Config");
    pixels.setPixelColor(0, pixels.Color(255, 255, 0)); pixels.show();
    WiFiManager wm;
    wm.setConnectTimeout(300); // 5 minutos para configurar
    if (!wm.autoConnect("LETE-Monitor-Config")) { // Aquí autoConnect es correcto
    Serial.println("Fallo al conectar desde el portal o se agotó el tiempo. Reiniciando...");
    delay(3000);
    ESP.restart();
    }
// Si llega aquí, autoConnect funcionó y estamos conectados.
} else {
// CASO 2: SÍ HAY CREDENCIALES
// Dejar que el ESP32 se conecte automáticamente en segundo plano.
// Las tareas writerTask y messengerTask ya tienen reintentos.
Serial.println("Credenciales encontradas. Intentando autoconexión a red guardada...");
pixels.setPixelColor(0, pixels.Color(0, 0, 255)); pixels.show();
// No llamamos a WiFi.begin() explícitamente, el ESP lo hace solo.
}
// ESPERAR UN POCO a que se conecte (si tenía credenciales)
int retries = 0;
Serial.print("Esperando conexión (max 10s)...");
while (WiFi.status() != WL_CONNECTED && retries < 20) { // Esperar max 10 segundos
delay(500);
Serial.print(".");
retries++;
}
Serial.println();
// Si después de la espera (o del portal) estamos conectados, lo mostramos.
// Si no, no pasa nada, las tareas lo reintentarán.
if (WiFi.status() == WL_CONNECTED) {
Serial.println("\n--------------------------------------------------");
Serial.println("WiFi Conectado con Éxito!");
Serial.printf("  SSID: %s\n", WiFi.SSID().c_str());
Serial.printf("  IP: %s\n", WiFi.localIP().toString().c_str());
Serial.printf("  RSSI: %d dBm\n", WiFi.RSSI());
Serial.println("--------------------------------------------------");
pixels.setPixelColor(0, pixels.Color(0, 255, 0)); pixels.show();
} else {
Serial.println("No se pudo conectar al WiFi. El dispositivo reintentará en segundo plano.");
pixels.setPixelColor(0, pixels.Color(255, 165, 0)); // LED Naranja
}
delay(1000); // Pequeña pausa

    // <<<<<<< INICIO DE LA LÓGICA DE CALIBRACIÓN >>>>>>>
    drawBootScreen("Cargando config..."); // <--- NUEVA PANTALLA DE ARRANQUE
    Serial.println("\n--- GESTIÓN DE CONFIGURACIÓN ---");
    // 1. Carga la última configuración válida guardada en la SD.
    Serial.print("Cargando calibración desde la SD...");
    loadCalibration(); 
    Serial.println(" OK.");
    if(DEBUG_MODE) Serial.printf("   Valores cargados de SD -> V_CAL: %.2f, P_CAL: %.2f\n", voltage_cal, phase_cal);
    
    // 2. Contacta a Supabase para buscar nuevas calibraciones o comandos.
    bool newConfigDownloaded = handleRemoteTasks();
    
    // 3. Si se descargó una nueva calibración, la guardamos de vuelta en la SD.
    if (newConfigDownloaded) {
        Serial.print("Nueva configuración remota detectada. Guardando en SD...");
        saveCalibration();
        Serial.println(" OK.");
    } else {
        Serial.println("No hay nuevas configuraciones remotas. Usando configuración actual.");
    }

    // --- 4. APLICAR CONFIGURACIÓN A EMONLIB ---
    // ¡CORRECCIÓN! Se aplica la calibración (de SD o Supabase) a EmonLib.
    applyCalibration();

    // ¡¡SOLUCIÓN AQUÍ!!
    // Avisar al Core 1 (writerTask) que la calibración está lista
    // y que ya puede empezar a medir.
    calibration_complete = true;
    if(DEBUG_MODE) Serial.println("[SETUP] Bandera 'calibration_complete' activada.");

    Serial.println("--------------------------------");
    // <<<<<<< FIN DE LA LÓGICA DE CALIBRACIÓN >>>>>>>

    // --- 5. SERVIDOR WEB Y OTA ---
    Serial.print("Configurando OTA...");
    drawBootScreen("Iniciando OTA..."); // <--- NUEVA PANTALLA DE ARRANQUE
    
    //server.on("/", handleRoot);
    //server.on("/calibracion", handleCalibration);
    // ... (resto de tus server.on) ...
    //server.begin();
    
    ArduinoOTA.setHostname("lete-monitor");
    ArduinoOTA.setPassword(OTA_PASSWORD);
    ArduinoOTA.begin();
    Serial.println(" OK.");

    // --- 6. CONFIGURAR CLIENTE MQTT ---
    Serial.print("Configurando cliente MQTT...");
    // Usamos la variable dinámica (de Supabase) en lugar de una IP fija
    client.setServer(currentServerUrl.c_str(), MQTT_PORT);
    client.setKeepAlive(60);
    Serial.println(" OK.");

    // --- 7. INICIAR TAREAS DE LOS NÚCLEOS ---
    Serial.print("Iniciando tareas en los núcleos 0 y 1...");
    drawBootScreen("Iniciando tareas..."); // <--- NUEVA PANTALLA DE ARRANQUE
    xTaskCreatePinnedToCore(writerTask, "WriterTask", 10000, NULL, 2, &writerTaskHandle, 1);
    xTaskCreatePinnedToCore(messengerTask, "MessengerTask", 32768, NULL, 1, &messengerTaskHandle, 0);
    Serial.println(" OK.");
    
    drawBootScreen("¡Listo!"); // <--- NUEVA PANTALLA DE ARRANQUE
    delay(1000); // Pequeña pausa para ver el mensaje final

    Serial.println("\n==================================================");
    Serial.println("== Setup completo. El control pasa a las tareas ==");
    Serial.println("==================================================");
}

// =========================================================================
// === LOOP PRINCIPAL (VACÍO Y OPTIMIZADO) =================================
// =========================================================================
void loop() {
    // Correcto: El loop principal se deshabilita para ceder todo el control a las tareas.
    // Esta es la mejor práctica en un firmware basado en tareas (RTOS).
    vTaskDelay(portMAX_DELAY);
}

// =========================================================================
// --- FUNCIÓN DE ACTUALIZACIÓN OTA (VERSIÓN FINAL CON DEPURACIÓN) ---
// =========================================================================
void checkForHttpUpdate() {
    if (WiFi.status() != WL_CONNECTED) {
        if (DEBUG_MODE) Serial.println("[N0] Omitiendo búsqueda de actualizaciones: WiFi desconectado.");
        return;
    }
    
    if (DEBUG_MODE) Serial.println("\n[N0] ==> Buscando actualizaciones de firmware...");
    
    // --- PASO 1: VERIFICAR VERSIÓN DISPONIBLE (HTTP) ---
    WiFiClient clientVersion;
    HTTPClient http;
    
    if(DEBUG_MODE) Serial.printf("[N0-Debug] Consultando versión: %s\n", FIRMWARE_VERSION_URL);
    
    if (!http.begin(clientVersion, FIRMWARE_VERSION_URL)) {
        if(DEBUG_MODE) Serial.println("[N0] ERROR: No se pudo iniciar cliente HTTP para versión.");
        return;
    }

    int httpCode = http.GET();
    if (httpCode != HTTP_CODE_OK) {
        if (DEBUG_MODE) {
            Serial.printf("[N0] ERROR: No se pudo verificar versión (HTTP: %d).\n", httpCode);
        }
        http.end();
        return;
    }
    
    String version_str = http.getString();
    http.end();
    
    version_str.trim();
    float new_version = version_str.toFloat();
    
    if (DEBUG_MODE) Serial.printf("[N0] Versión actual: %.1f, Versión servidor: %.1f\n", FIRMWARE_VERSION, new_version);
    
    if (new_version <= FIRMWARE_VERSION) {
        if (DEBUG_MODE) Serial.println("[N0] Firmware ya está actualizado.");
        return;
    }
    
    // --- PASO 2: PREPARAR SISTEMA PARA ACTUALIZACIÓN ---
    if (DEBUG_MODE) Serial.println("[N0] ¡Nueva versión disponible! Preparando sistema...");
    if (OLED_CONECTADA) drawGenericMessage("Actualizando", "Preparando...");
    
    // Reportar RAM libre ANTES de liberar
    if (DEBUG_MODE) Serial.printf("[N0-Debug] RAM libre antes de preparar: %d bytes\n", ESP.getFreeHeap());
    
    // --- CRÍTICO: PAUSAR TAREA DEL CORE 1 ---
    if(DEBUG_MODE) Serial.println("[N0] ==> Pausando Tarea Escritura (Core 1)...");
    vTaskSuspend(writerTaskHandle);
    delay(500); // Dar tiempo suficiente
    
    
    // --- CRÍTICO: DESHABILITAR OTA ---
    ArduinoOTA.end();
    
    // --- CRÍTICO: CERRAR ARCHIVOS ABIERTOS EN SD ---
    if(DEBUG_MODE) Serial.println("[N0] ==> Desmontando SD...");
    SD.end();
    delay(100);
    
    // Reportar RAM libre DESPUÉS de liberar
    if (DEBUG_MODE) Serial.printf("[N0-Debug] RAM libre después de preparar: %d bytes\n", ESP.getFreeHeap());
    
    // --- PASO 3: VERIFICAR QUE TENEMOS SUFICIENTE RAM ---
    uint32_t freeHeap = ESP.getFreeHeap();
    const uint32_t MIN_HEAP_REQUIRED = 100000; // 100KB mínimo
    
    if (freeHeap < MIN_HEAP_REQUIRED) {
        if (DEBUG_MODE) {
            Serial.printf("[N0] ERROR: RAM insuficiente (%d bytes). Se requieren al menos %d bytes.\n", 
                freeHeap, MIN_HEAP_REQUIRED);
            Serial.println("[N0] Abortando actualización. Reiniciando dispositivo...");
        }
        delay(3000);
        ESP.restart();
        return;
    }
    
    if (DEBUG_MODE) Serial.printf("[N0] RAM disponible: %d bytes. Continuando...\n", freeHeap);
    
    // --- PASO 4: VERIFICAR CONECTIVIDAD ---
    if(DEBUG_MODE) Serial.println("[N0-Debug] Verificando conectividad...");
    WiFiClient testClient;
    
    String binUrl = String(FIRMWARE_BIN_URL);
    int hostStart = binUrl.indexOf("://") + 3;
    int hostEnd = binUrl.indexOf("/", hostStart);
    String host = binUrl.substring(hostStart, hostEnd);
    
    if(DEBUG_MODE) Serial.printf("[N0-Debug] Conectando a: %s:80\n", host.c_str());
    
    if (!testClient.connect(host.c_str(), 80)) {
        if(DEBUG_MODE) Serial.println("[N0] ERROR: No se puede conectar al servidor.");
        ESP.restart(); // Reiniciar en lugar de solo resumir
        return;
    }
    testClient.stop();
    if(DEBUG_MODE) Serial.println("[N0-Debug] Conectividad OK.");
    
    // --- PASO 5: CONFIGURAR ACTUALIZACIÓN ---
    if (OLED_CONECTADA) drawGenericMessage("Actualizando", "Descargando...");
    
    WiFiClient clientOTA;
    
    httpUpdate.setFollowRedirects(HTTPC_FORCE_FOLLOW_REDIRECTS);
    httpUpdate.rebootOnUpdate(true); // ¡CAMBIO! Reinicio automático si éxito
    
    // Callback simplificado (menos uso de RAM)
    httpUpdate.onProgress([](int progress, int total) {
        static int lastPercent = -1;

        int percent = (progress * 100) / total;
        
        // Solo imprimir y actualizar pantalla si el porcentaje cambió
        if (percent != lastPercent) {
            if(DEBUG_MODE) Serial.printf("[N0-OTA] %d%%\n", percent);
            
            // Usamos la nueva función del oled_screens.h
            if (OLED_CONECTADA) {
                drawUpdateScreen("Descargando...", percent);
            }
            
            lastPercent = percent;
            esp_task_wdt_reset();
        }
    });
    
    httpUpdate.onStart([]() {
        if(DEBUG_MODE) Serial.println("[N0-OTA] Iniciando descarga...");
    });
    
    httpUpdate.onEnd([]() {
        if(DEBUG_MODE) Serial.println("[N0-OTA] ¡Completado! Reiniciando...");
        if (OLED_CONECTADA) drawGenericMessage("Actualizacion", "Completada!");
    });
    
    httpUpdate.onError([](int error) {
        if(DEBUG_MODE) {
            Serial.printf("[N0-OTA] Error: %d\n", error);
            Serial.printf("[N0-OTA] Detalle: %s\n", HTTPUpdate().getLastErrorString().c_str());
        }
    });
    
    // --- PASO 6: EJECUTAR ACTUALIZACIÓN ---
    if(DEBUG_MODE) Serial.printf("[N0-Debug] Descargando: %s\n", FIRMWARE_BIN_URL);
    if(DEBUG_MODE) Serial.printf("[N0-Debug] RAM libre justo antes de update(): %d bytes\n", ESP.getFreeHeap());
    
    esp_task_wdt_reset();
    
    t_httpUpdate_return ret = httpUpdate.update(clientOTA, FIRMWARE_BIN_URL);
    
    // --- PASO 7: EVALUAR RESULTADO (solo si falla, porque success reinicia auto) ---
    if (ret == HTTP_UPDATE_FAILED) {
        if (DEBUG_MODE) {
            Serial.println("[N0] ERROR: Actualización falló.");
            Serial.printf("[N0-Debug] Error (%d): %s\n", 
                httpUpdate.getLastError(), 
                httpUpdate.getLastErrorString().c_str());
        }
        if (OLED_CONECTADA) drawGenericMessage("Actualizacion", "Error!");
        delay(5000);
        ESP.restart(); // Reiniciar de todos modos
    }
    
    // Si llegamos aquí, algo raro pasó
    if (DEBUG_MODE) Serial.println("[N0] Estado inesperado. Reiniciando...");
    delay(2000);
    ESP.restart();
}

// =========================================================================
// --- FUNCIÓN PARA GUARDAR CALIBRACIÓN (VERSIÓN FINAL CON DEPURACIÓN) ---
// =========================================================================

void saveCalibration() {
    if (DEBUG_MODE) Serial.println("\n[N0] ==> Guardando datos de calibración en la SD...");
    
    // Abrimos el archivo en modo escritura. Esto creará el archivo si no existe,
    // o lo sobrescribirá si ya existe.
    File file = SD.open("/calibracion.json", FILE_WRITE);
    if (!file) {
        if (DEBUG_MODE) Serial.println("[N0] ERROR CRÍTICO: No se pudo abrir '/calibracion.json' para escritura.");
        return;
    }

    StaticJsonDocument<256> doc;
    
    // Asignamos los valores actuales de las variables globales al documento JSON
    doc["voltage_cal"] = voltage_cal;
    doc["current_cal_phase"] = current_cal_phase;
    doc["current_cal_neutral"] = current_cal_neutral;
    doc["phase_cal"] = phase_cal; // <-- AÑADIDO: Guardar el factor de potencia
    
    if (DEBUG_MODE) {
        Serial.println("[N0-Debug] Valores de calibración a guardar:");
        Serial.printf("  - voltage_cal: %.2f\n", (float)doc["voltage_cal"]);
        Serial.printf("  - current_cal_phase: %.2f\n", (float)doc["current_cal_phase"]);
        Serial.printf("  - current_cal_neutral: %.2f\n", (float)doc["current_cal_neutral"]);
        Serial.printf("  - phase_cal: %.2f\n", (float)doc["phase_cal"]);
    }
    
    // Escribimos el documento JSON al archivo.
    // serializeJson() devuelve el número de bytes escritos. Si es 0, hubo un error.
    if (serializeJson(doc, file) == 0) {
        if (DEBUG_MODE) Serial.println("[N0] ERROR: Fallo al escribir datos JSON en el archivo.");
    } else {
        if (DEBUG_MODE) Serial.println("[N0] ÉXITO: Calibración guardada correctamente en /calibracion.json");
    }
    
    // Cerramos el archivo para asegurar que todos los datos se escriban en la tarjeta.
    file.close();
}

// =========================================================================
// --- FUNCIÓN PARA CARGAR CALIBRACIÓN (VERSIÓN FINAL CON DEPURACIÓN) ---
// =========================================================================

void loadCalibration() {
    if (DEBUG_MODE) Serial.print("Buscando archivo de calibración (/calibracion.json)...");

    if (SD.exists("/calibracion.json")) {
        if (DEBUG_MODE) Serial.println(" Archivo encontrado.");
        File file = SD.open("/calibracion.json", FILE_READ);
        if (file) {
            if (DEBUG_MODE) Serial.print("Leyendo y parseando archivo JSON...");
            StaticJsonDocument<256> doc;
            DeserializationError error = deserializeJson(doc, file);
            
            if (!error) {
                if (DEBUG_MODE) Serial.println(" OK.");
                // Cargamos cada valor solo si la clave existe en el archivo
                if (doc.containsKey("voltage_cal")) voltage_cal = doc["voltage_cal"];
                if (doc.containsKey("current_cal_phase")) current_cal_phase = doc["current_cal_phase"];
                if (doc.containsKey("current_cal_neutral")) current_cal_neutral = doc["current_cal_neutral"];
                if (doc.containsKey("phase_cal")) phase_cal = doc["phase_cal"]; // <-- AÑADIDO: Cargar el factor de potencia

                if (DEBUG_MODE) {
                    Serial.println("--------------------------------------------------");
                    Serial.println("Valores de Calibración Cargados en Memoria:");
                    Serial.printf("  - voltage_cal: %.2f\n", voltage_cal);
                    Serial.printf("  - current_cal_phase: %.2f\n", current_cal_phase);
                    Serial.printf("  - current_cal_neutral: %.2f\n", current_cal_neutral);
                    Serial.printf("  - phase_cal: %.2f\n", phase_cal);
                    Serial.println("--------------------------------------------------");
                }
            } else {
                // Si hay un error, lo reportamos con detalle
                if (DEBUG_MODE) {
                    Serial.println(" ¡ERROR!");
                    Serial.printf("ERROR: Fallo al parsear /calibracion.json. Error: %s\n", error.c_str());
                    Serial.println("Se usarán los valores de calibración por defecto.");
                }
            }
            file.close();
        } else {
            if (DEBUG_MODE) Serial.println("\nERROR: No se pudo abrir el archivo /calibracion.json para lectura.");
        }
    } else {
        // Si el archivo no existe, lo creamos con los valores por defecto que están en las variables globales.
        if (DEBUG_MODE) {
            Serial.println(" ¡No encontrado!");
            Serial.println("Creando archivo de calibración con valores por defecto...");
        }
        saveCalibration(); // Llamamos a la función que ya revisamos para crear el archivo
    }
}

// =========================================================================
// --- FUNCIÓN PARA APLICAR LA CALIBRACIÓN A EMONLIB ---
// =========================================================================

void applyCalibration() {
    if (DEBUG_MODE) {
        Serial.println("\n[SISTEMA] Aplicando nueva configuración de calibración a EmonLib...");
        Serial.printf("  - V_CAL: %.2f\n", voltage_cal);
        Serial.printf("  - I_CAL_Fase: %.2f\n", current_cal_phase);
        Serial.printf("  - I_CAL_Neutro: %.2f\n", current_cal_neutral);
        Serial.printf("  - P_CAL (Phase): %.2f\n", phase_cal);
    }
    
    // Reconfigura los objetos de EmonLib con los valores globales actualizados
    emon_phase.voltage(VOLTAGE_PIN, voltage_cal, phase_cal);
    emon_phase.current(CURRENT_PHASE_PIN, current_cal_phase);
    emon_neutral.current(CURRENT_NEUTRAL_PIN, current_cal_neutral);
}

// =========================================================================
// --- FUNCIÓN DEL SERVIDOR WEB - handleFactoryReset (MODIFICADA SIN WEBSERVER) -----
// =========================================================================

void handleFactoryReset() {

    if (DEBUG_MODE) Serial.println("\n[N0] !ADVERTENCIA! Petición web '/factory-reset' recibida. Se borrarán todos los datos.");

    // --- AÑADIDO: Mensaje en pantalla para el usuario ---
    if (OLED_CONECTADA) {
        drawGenericMessage("Reseteo de Fabrica", "Borrando datos...");
    }

    // 1. Borrar archivo de calibración de la SD
    if (SD.exists("/calibracion.json")) {
        if (SD.remove("/calibracion.json")) {
            if (DEBUG_MODE) Serial.println("[N0] Archivo de calibración borrado de la SD.");
        }
    }

    // --- AÑADIDO: Borrar archivo de buffer por si existiera ---
    if (SD.exists("/buffer.dat")) {
        if (SD.remove("/buffer.dat")) {
            if (DEBUG_MODE) Serial.println("[N0] Archivo de buffer borrado de la SD.");
        }
    }

    // 2. Borrar todos los archivos de datos de la SD (puede tardar)
    if (DEBUG_MODE) Serial.println("[N0] Buscando y borrando archivos de datos (.dat)...");
    File root = SD.open("/");
    if (root) {
        File file = root.openNextFile();
        while(file){
            String filename = file.name();
// Borramos solo los archivos que nos interesan para no borrar archivos de sistema
    if (filename.endsWith(".dat")) {
        if (DEBUG_MODE) Serial.printf("[N0-Debug]   - Borrando: %s\n", filename.c_str());
            SD.remove("/" + filename);
        }
        file.close(); // Cerramos el handle del archivo actual
            file = root.openNextFile(); // Pasamos al siguiente
    }
        root.close(); // Cerramos el directorio raíz
        if (DEBUG_MODE) Serial.println("[N0] Todos los archivos de datos han sido borrados.");
    }

    // 3. Borrar credenciales de WiFi
    if (DEBUG_MODE) Serial.print("[N0] Borrando credenciales de WiFi...");
    WiFiManager wm;
    wm.resetSettings();
    if (DEBUG_MODE) Serial.println(" OK.");

    // 4. Enviar respuesta y reinicia
    // server.send(200, "text/html", "<h1>Reseteo de Fábrica Completo. Reiniciando...</h1>"); // <--- LÍNEA ELIMINADA
    delay(2000);

    ESP.restart();
}

// Esta función devuelve 'true' si se descargó una nueva calibración, y 'false' si no.
bool handleRemoteTasks() {
    if (WiFi.status() != WL_CONNECTED) {
        if (DEBUG_MODE) Serial.println("[N0] Omitiendo chequeo de tareas: WiFi desconectado.");
        return false;
    }

    if (DEBUG_MODE) Serial.println("\n[N0] ==> Iniciando chequeo de tareas en Supabase...");

    bool newConfigFetched = false;
    String deviceId = WiFi.macAddress();
    deviceId.replace(":", ""); 
    
    String url = String(SUPABASE_URL) + "/functions/v1/device-tasks?deviceId=" + deviceId;

    WiFiClientSecure clientSecure;
    clientSecure.setInsecure();

    HTTPClient http;
    http.begin(clientSecure, url);
    http.addHeader("apikey", String(SUPABASE_ANON_KEY));
    http.addHeader("Authorization", "Bearer " + String(SUPABASE_ANON_KEY));
    http.setTimeout(8000);

    int httpCode = http.GET();

    if (httpCode == HTTP_CODE_OK) {
        String responsePayload = http.getString();
        if (DEBUG_MODE) Serial.printf("[N0] Respuesta de Supabase: %s\n", responsePayload.c_str());

        StaticJsonDocument<512> doc;
        DeserializationError error = deserializeJson(doc, responsePayload);

        if (error) {
            if (DEBUG_MODE) Serial.printf("[N0] ERROR: Fallo al parsear JSON de tareas: %s\n", error.c_str());
        } else {
            
            // --- 1. PROCESAR ESTADO DE SUSCRIPCIÓN (Lógica JSON v2.0) ---
            if (doc.containsKey("subscription") && !doc["subscription"].isNull()) {
                if(DEBUG_MODE) Serial.println("[N0] Procesando objeto de suscripción...");
                
                JsonObject sub = doc["subscription"];
                
                // Usamos .as<String>() para manejar de forma segura si el valor es nulo
                String status_str = sub["status"].as<String>();
                String next_pay_str = sub["next_payment_date"].as<String>();
                
                // Usamos el operador '|' como valor por defecto si la clave no existe
                int grace_days_val = sub["grace_days"] | 0;
                long next_pay_ts_val = sub["next_payment_ts"] | 0;

                // Actualizamos las variables globales de forma segura
                if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                    subscription_active = (status_str == "active");
                    dias_de_gracia_restantes = grace_days_val;
                    pago_vencido = !subscription_active;
                    sub_next_payment_str = next_pay_str;
                    sub_active_until_ts = next_pay_ts_val;
                    
                    xSemaphoreGive(sharedVarsMutex);
                    
                    if(DEBUG_MODE) {
                       Serial.println("[N0] ÉXITO: Datos de suscripción actualizados en memoria.");
                       Serial.printf("     - Status: %s, Gracia: %d, Vencido: %s\n",
                           subscription_active ? "Activa" : "Inactiva",
                           dias_de_gracia_restantes,
                           pago_vencido ? "SI" : "NO");
                       Serial.printf("     - Prox. Pago: %s (TS: %lu)\n", sub_next_payment_str.c_str(), sub_active_until_ts);
                    }
                }
            } else {
                if(DEBUG_MODE) Serial.println("[N0] ADVERTENCIA: No se encontró el objeto 'subscription' en la respuesta de Supabase.");
            }

            // <<<<<<< INICIO DE LA CORRECCIÓN >>>>>>>
            // (Esta sección ya la tenías, solo asegúrate que siga después de la de suscripción)

            // <<<<<<< INICIO DE LA CORRECCIÓN >>>>>>>
            // --- 2. PROCESAR LA URL DEL SERVIDOR DE DATOS ---
            // Se mueve aquí, al nivel principal del JSON, no anidado.
            if (doc.containsKey("server_url") && !doc["server_url"].isNull()) {
            currentServerUrl = doc["server_url"].as<String>();
            if (DEBUG_MODE) Serial.printf("[N0] URL del servidor de datos actualizada a: %s\n", currentServerUrl.c_str());
            }

            // --- 2. PROCESAR ACTUALIZACIÓN DE CALIBRACIÓN ---
            JsonObject calibration = doc["calibration"];
            if (calibration.containsKey("update_available") && calibration["update_available"] == true) {
                if (DEBUG_MODE) Serial.println("[N0] Tarea de 'actualizar calibración' recibida.");
                
                JsonObject values = calibration["values"];
                voltage_cal = values["voltage"];
                current_cal_phase = values["current1"];
                current_cal_neutral = values["current2"];
                
                if (values.containsKey("phase_cal")) {
                     phase_cal = values["phase_cal"];
                }

                // --- CORRECCIÓN AÑADIDA ---
                applyCalibration(); // Aplicar inmediatamente la nueva calibración

                newConfigFetched = true;
                if (DEBUG_MODE) Serial.println("[N0] ¡ÉXITO! Variables de calibración actualizadas.");
            }

            // --- 3. PROCESAR COMANDOS ---
            if (doc.containsKey("command") && !doc["command"].isNull()) {
                String cmd = doc["command"];
                if (DEBUG_MODE) Serial.printf("[N0] Tarea de 'comando' recibida: '%s'\n", cmd.c_str());

                if (cmd == "reboot") {
                    if (DEBUG_MODE) Serial.println("[N0] Ejecutando comando REBOOT en 3 segundos...");
                    delay(3000);
                    ESP.restart();
                } else if (cmd == "factory_reset") {
                    if (DEBUG_MODE) Serial.println("[N0] Comando remoto 'factory_reset' recibido. Ejecutando...");
                    handleFactoryReset(); // Llama aquí a tu función de reseteo de fábrica
                }
            }
        }
    } else {
        if (DEBUG_MODE) Serial.printf("[N0] ERROR: Fallo al obtener tareas (HTTP: %d). Respuesta: %s\n", httpCode, http.getString().c_str());
    }
    
    http.end();
    return newConfigFetched;
}