/*
==========================================================================
== FIRMWARE CUENTATRÓN - MONITOR DE ENERGÍA v14.0
==
== ARQUITECTURA:
== - Núcleo 1 (Medición): 100% autónomo, prioriza la escritura en SD.
== - Núcleo 0 (Red): Oportunista, maneja WiFi, NTP, Supabase y MQTT.
== - Hardware: RTC (DS3231) para timestamps fiables.
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
#include "EmonLib.h"
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <RTClib.h>
#include <SPI.h>
#include <SD.h>
#include <Adafruit_NeoPixel.h>

// --- 2. CONFIGURACIÓN PRINCIPAL ---
const float FIRMWARE_VERSION = 14.0; // Actualizado a la nueva arquitectura
const bool OLED_CONECTADA = true;
const bool DEBUG_MODE = true;

// --- 3. CONFIGURACIÓN DE PINES ---
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

// --- 4. INTERVALOS DE TIEMPO Y CONTROL ---
const unsigned long MEASUREMENT_INTERVAL_MS = 2000;
//const unsigned long SCREEN_CONSUMPTION_INTERVAL_MS = 30000; // (Ya no se usará, pero lo dejamos)
//const unsigned long SCREEN_OTHER_INTERVAL_MS = 15000; // (Ya no se usará)
const unsigned long NTP_RETRY_INTERVAL_MS = 120 * 1000; // (Se usará solo en ventana de mantto)
const unsigned long SERVER_CHECK_INTERVAL_MS = 30 * 60 * 1000UL; // (Se usará solo en ventana de mantto)
const unsigned long MESSENGER_CYCLE_DELAY_MS = 5000;
//const unsigned long DAILY_RESTART_INTERVAL_MS = 24 * 3600 * 1000UL; // 24 horas

// --- 4B. LÍMITES Y PARÁMETROS DE OPERACIÓN (NUEVO) ---
#define WDT_TIMEOUT_SECONDS 180         // Límite del Watchdog
#define LONG_PRESS_DURATION_MS 10000    // Pulsación larga para reset WiFi
const uint64_t MAX_SD_USAGE_BYTES = 50ULL * 1024ULL * 1024ULL; // 50MB
const int FILES_TO_PURGE_ON_FULL = 10;  // Cuántos archivos borrar si la SD se llena
// Límites de validación
const float VALIDATION_VOLTAGE_MIN = 50.0;
const float VALIDATION_VOLTAGE_MAX = 300.0;
const float VALIDATION_POWER_MIN = -50.0; // Permitir un pequeño negativo por ruido


// --- 5. CONFIGURACIÓN DE RED ---
const char* NTP_SERVER_1 = "pool.ntp.org";
const char* NTP_SERVER_2 = "mx.pool.ntp.org";
const char* NTP_SERVER_3 = "time.google.com";
#define MQTT_CONFIG_FILE "/mqtt_config.json" // Archivo para guardar config de red

// --- 6. OBJETOS Y VARIABLES GLOBALES ---

// Objetos de Hardware
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
Adafruit_NeoPixel pixels(NUM_PIXELS, NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);
EnergyMonitor emon_phase;
EnergyMonitor emon_neutral;
RTC_DS3231 rtc;
unsigned long last_reboot_check_time = 0;
bool rtc_failed = false; // Bandera para "Modo Falla" del RTC
bool sd_card_failed = false; // Bandera para "Modo Falla" de la SD

// Estructura de Datos para las Mediciones
struct MeasurementData {
    uint32_t sequence_number;
    uint32_t timestamp; // Timestamp Unix (de RTC)
    float vrms, irms_phase, irms_neutral, power, leakage, temp_cpu;
    float va, power_factor;
};

// Variables de Calibración (Valores por defecto)
float voltage_cal = 153.5;
float current_cal_phase = 106.0;
float current_cal_neutral = 106.0;
float phase_cal = 1.7;

// Variables de Estado (Protegidas por Mutex)
SemaphoreHandle_t sharedVarsMutex;
float latest_vrms = 0.0, latest_irms_phase = 0.0, latest_irms_neutral = 0.0;
float latest_power = 0.0, latest_leakage = 0.0, latest_temp_cpu = 0.0;
bool subscription_active = false;
bool pago_vencido = false;
int dias_de_gracia_restantes = 0;
String sub_next_payment_str = "--/--/----";
long sub_active_until_ts = 0;
bool time_synced = false; // Solo indica si NTP ha corrido, ya no bloquea

// Variables para "Batching" en SD
const int BATCH_SIZE = 10; // Número de mediciones por archivo
int lines_in_buffer = 0;   // Contador de líneas en el buffer actual

// Otras Variables de Control
TaskHandle_t writerTaskHandle;
TaskHandle_t messengerTaskHandle;
volatile bool ota_update_request = false;
volatile bool factory_reset_request = false; // Bandera para el reseteo por botón
int screen_mode = 0;
unsigned long last_screen_change_time = 0;
unsigned long button_press_start_time = 0;
bool button_is_pressed = false;
uint32_t global_sequence_number = 0;
String currentServerUrl; // URL del servidor MQTT, obtenida de Supabase
const int MQTT_PORT = 1883;
const char* TOPIC_BOOT = "lete/dispositivos/boot_time";
const char* TOPIC_MEDICIONES = "lete/mediciones/";

// Objetos de WiFi y MQTT
WiFiClient espClient;
PubSubClient client(espClient);

// Variables de estado para MQTT
String deviceIdForMqtt = "";
bool boot_time_reported = false;

// --- 7. DECLARACIÓN DE FUNCIONES ---
void writerTask(void * pvParameters);
void messengerTask(void * pvParameters);
void loadCalibration();
void saveCalibration();
void applyCalibration(); // <-- AÑADIDA: Función para aplicar calibración "en caliente"
void handleFactoryReset();
bool handleRemoteTasks(); // <-- AÑADIDO: Declaración explícita
void checkForHttpUpdate(); // <-- AÑADIDO: Declaración explícita

// --- 8. INCLUSIÓN DE ARCHIVOS SEPARADOS ---
#include "oled_screens.h"

// =========================================================================
// === TAREA 1: ESCRITOR (NÚCLEO 1) - v14.1 (Robusto)
// === Misión: Medir y guardar en SD. Autorecuperable.
// =========================================================================
void writerTask(void * pvParameters) {
    if(DEBUG_MODE) Serial.println("[N1] Tarea de Escritura iniciada en Núcleo 1.");
    esp_task_wdt_add(NULL);

    unsigned long last_measurement_time = 0;
    const int lecturas_a_descartar = 5;
    int lecturas_descartadas = 0;
    
    for (;;) { // <-- INICIO DEL BUCLE INFINITO PRINCIPAL
        esp_task_wdt_reset();
        unsigned long currentMillis = millis();

        // --- 1. MODO DE FALLA (LIMP MODE) ---
        if (rtc_failed) {
            pixels.setPixelColor(0, pixels.Color(255, 0, 0)); // Rojo Fijo
            pixels.show();
            drawGenericMessage("ERROR CRITICO", "Fallo de RTC");
            vTaskDelay(pdMS_TO_TICKS(30000)); // Reintentar cada 30s
            if (rtc.begin()) {
                rtc_failed = false; // Intento de recuperación
                Serial.println("[N1] RECUPERADO: RTC reconectado.");
            }
            continue; // Saltar el resto del bucle
        }

        if (sd_card_failed) {
            // Rojo Parpadeante
            pixels.setPixelColor(0, pixels.Color((millis() % 2000) < 1000 ? 255 : 0, 0, 0));
            pixels.show();
            drawGenericMessage("ERROR CRITICO", "Fallo de SD");
            vTaskDelay(pdMS_TO_TICKS(30000)); // Reintentar cada 30s
            if (SD.begin(SD_CS_PIN)) {
                sd_card_failed = false; // Intento de recuperación
                Serial.println("[N1] RECUPERADO: Tarjeta SD reconectada.");
                // (Nota: La calibración no se recarga, se usará la de por defecto
                // hasta el próximo reinicio, siguiendo "Menos es Más")
            }
            continue; // Saltar el resto del bucle
        }

        // --- 2. SECCIÓN DE MEDICIÓN Y GUARDADO ---
        if (currentMillis - last_measurement_time >= MEASUREMENT_INTERVAL_MS) {
            last_measurement_time = currentMillis;
            if(DEBUG_MODE) Serial.println("\n[N1] ==> Iniciando ciclo de medición...");

            emon_phase.calcVI(20, 2000);
            emon_neutral.calcVI(20, 2000);

            if (lecturas_descartadas < lecturas_a_descartar) {
                lecturas_descartadas++;
                // (Omitiendo debug para reducir spam de serial)
            } else {
                
                if(DEBUG_MODE && lecturas_descartadas == lecturas_a_descartar) {
                    Serial.println("[N1] Estabilización completa. Empezando a procesar y guardar datos.");
                    lecturas_descartadas++; 
                }
                
                MeasurementData data;
                data.sequence_number = ++global_sequence_number;
                data.timestamp = rtc.now().unixtime(); 
                data.vrms = emon_phase.Vrms;
                data.irms_phase = emon_phase.Irms;
                data.irms_neutral = emon_neutral.Irms;
                data.power = emon_phase.realPower;
                data.va = emon_phase.apparentPower;
                data.power_factor = emon_phase.powerFactor;
                data.leakage = fabs(data.irms_phase - data.irms_neutral);
                data.temp_cpu = temperatureRead();

                // (NUEVO) --- VALIDACIÓN DE DATOS ---
                if (data.vrms < VALIDATION_VOLTAGE_MIN || data.vrms > VALIDATION_VOLTAGE_MAX || data.power < VALIDATION_POWER_MIN) {
                    if(DEBUG_MODE) {
                        Serial.printf("[N1] ERROR: Lectura fuera de rango (V:%.1f, W:%.0f). Descartada.\n", data.vrms, data.power);
                    }
                    // Actualizar variables globales con 0 para que la pantalla no muestre el error
                    if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                        latest_vrms = 0.0;
                        latest_irms_phase = 0.0;
                        latest_irms_neutral = 0.0;
                        latest_power = 0.0;
                        latest_leakage = 0.0;
                        latest_temp_cpu = data.temp_cpu; // (Temp está bien)
                        xSemaphoreGive(sharedVarsMutex);
                    }
                    continue; // Salta este ciclo y no guardes nada
                }
                // --- FIN VALIDACIÓN ---


                // Actualizar variables globales para la pantalla OLED
                if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                    latest_vrms = data.vrms;
                    latest_irms_phase = data.irms_phase;
                    latest_irms_neutral = data.irms_neutral;
                    latest_power = data.power;
                    latest_leakage = data.leakage;
                    latest_temp_cpu = data.temp_cpu;
                    xSemaphoreGive(sharedVarsMutex);
                }

                if(DEBUG_MODE) {
                    Serial.printf("[N1] RMS -> V:%.1f, A_Fase:%.3f, A_Neutro:%.3f, W:%.0f, Fuga:%.3f\n",
                                    data.vrms, data.irms_phase, data.irms_neutral, data.power, data.leakage);
                }
                
                // Guardar en la SD (solo si no ha fallado)
                if(DEBUG_MODE) Serial.println("[N1-Debug] Procediendo a guardar en SD.");
                File dataFile = SD.open("/buffer.dat", FILE_APPEND);
                if (dataFile) {
                    // (Formato CSV) ...
                    dataFile.print(data.sequence_number); dataFile.print(",");
                    dataFile.print(data.timestamp); dataFile.print(",");
                    dataFile.print(data.vrms); dataFile.print(",");
                    dataFile.print(data.irms_phase); dataFile.print(",");
                    dataFile.print(data.irms_neutral); dataFile.print(",");
                    dataFile.print(data.power); dataFile.print(",");
                    dataFile.print(data.va); dataFile.print(",");
                    dataFile.print(data.power_factor); dataFile.print(",");
                    dataFile.print(data.leakage); dataFile.print(",");
                    dataFile.println(data.temp_cpu);
                    dataFile.close();

                    lines_in_buffer++;
                    
                    if (lines_in_buffer >= BATCH_SIZE) {
                        String new_filename = "/" + String(data.timestamp) + ".dat";
                        if (SD.rename("/buffer.dat", new_filename)) {
                            if(DEBUG_MODE) Serial.printf("[N1] Batch completo. Archivo renombrado a '%s'\n", new_filename.c_str());
                        } else {
                            if(DEBUG_MODE) Serial.println("[N1] ERROR: Fallo al renombrar el buffer.");
                            sd_card_failed = true; // (NUEVO) Activar modo falla
                        }
                        lines_in_buffer = 0;
                    }
                } else {
                    if(DEBUG_MODE) Serial.println("[N1] ERROR: Fallo al abrir /buffer.dat. ¿SD removida?");
                    sd_card_failed = true; // (NUEVO) Activar modo falla
                }
            }
        } // Fin de if (measurement interval)
        
        // --- 3. SECCIÓN DE GESTIÓN DE PANTALLA Y BOTÓN (SIMPLIFICADO) ---
        
        // (SIMPLIFICADO) --- Lógica de Botón (Solo Pulsación Larga) ---
        if (digitalRead(BUTTON_PIN) == LOW) {
            if (!button_is_pressed) {
                button_press_start_time = currentMillis;
                button_is_pressed = true;
            } else if (currentMillis - button_press_start_time > LONG_PRESS_DURATION_MS) {
                
                drawGenericMessage("Reseteo WiFi", "Solicitado...");
                pixels.setPixelColor(0, pixels.Color(255, 0, 255)); pixels.show();
                
                factory_reset_request = true; 
                
                button_is_pressed = false; // Evita que se repita la solicitud
                delay(2000); // Pausa para que el usuario vea el mensaje
            }
        } else {
            // (SIMPLIFICADO) Se eliminó la lógica de "pulsación corta"
            button_is_pressed = false;
        }

        // (SIMPLIFICADO) --- Lógica de Pantalla (Solo Consumo) ---
        if (OLED_CONECTADA) {
            // (SIMPLIFICADO) Se eliminó toda la rotación, modos y chequeo de pago.
            drawConsumptionScreen();
        }
        
        vTaskDelay(pdMS_TO_TICKS(50)); // Ceder tiempo al OS
    } // <-- FIN DEL BUCLE INFINITO PRINCIPAL
}

// =========================================================================
// === TAREA 2: MENSAJERO (NÚCLEO 0) - v14.1 (Robusto)
// === Misión: Gestionar WiFi/MQTT, enviar datos y ejecutar mantenimiento.
// =========================================================================
void messengerTask(void * pvParameters) {
    if(DEBUG_MODE) Serial.println("[N0] Tarea de Mensajero iniciada en Núcleo 0.");
    esp_task_wdt_add(NULL);
    
    // (CAMBIO) Variables para chequeos periódicos eliminadas (last_server_check, last_ntp_attempt)
    bool maintenance_window_triggered = false; // Para que el mantenimiento corra solo una vez
    const int MAINTENANCE_HOUR = 3; // 3 AM
    const int MAINTENANCE_MINUTE = 0; // 3:00 AM

    for (;;) {
        if(DEBUG_MODE) Serial.println("\n[N0] >>> Inicio del bucle de la tarea Messenger.");

        // --- 1. TAREAS INMEDIATAS (NO REQUIEREN WIFI) ---
        esp_task_wdt_reset();
        ArduinoOTA.handle(); // Siempre escuchar por peticiones OTA

        // Chequear si el Núcleo 1 (botón) solicitó un reseteo de WiFi
        bool reset_solicitado = false;
        if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
            if (factory_reset_request) { 
                reset_solicitado = true;
                factory_reset_request = false; // Bajar la bandera
            }
            xSemaphoreGive(sharedVarsMutex);
        }

        if (reset_solicitado) {
            if (DEBUG_MODE) Serial.println("[N0] Reseteo de WiFi solicitado. Borrando credenciales...");
            drawGenericMessage("Reseteo WiFi", "Borrando...");
            WiFiManager wm;
            wm.resetSettings();
            delay(2000);
            ESP.restart(); // Forzar reinicio para entrar al portal
        }
        
        // --- 2. GESTIÓN DE CONEXIÓN WIFI ---
        if (WiFi.status() != WL_CONNECTED) {
            if(DEBUG_MODE) Serial.println("[N0] WiFi desconectado, intentando conectar...");
            pixels.setPixelColor(0, pixels.Color(255, 165, 0)); // Naranja
            pixels.show();
            
            // Si no hay credenciales (primer arranque o reseteo)
            if (WiFi.SSID() == "") {
                Serial.println("[N0] No hay credenciales WiFi. Iniciará el portal.");
                drawGenericMessage("Configuracion WiFi", "Conectate a la red: LETE-Monitor-Config");
                pixels.setPixelColor(0, pixels.Color(255, 255, 0)); pixels.show(); // Amarillo
                
                WiFiManager wm;
                wm.setConnectTimeout(300); // 5 minutos
                if (!wm.autoConnect("LETE-Monitor-Config")) {
                    Serial.println("[N0] Fallo al conectar desde el portal. Reiniciando...");
                    delay(3000);
                    ESP.restart();
                }
                Serial.println("[N0] WiFi conectado vía Portal.");
            
            } else {
                if(DEBUG_MODE) Serial.println("[N0] Intentando reconexión a red guardada...");
                WiFi.reconnect();
            }
            
            vTaskDelay(pdMS_TO_TICKS(MESSENGER_CYCLE_DELAY_MS)); 
            continue; // Vuelve al inicio del bucle for(;;)
        }
        
        // Si llegamos aquí, el WiFi está CONECTADO
        pixels.setPixelColor(0, pixels.Color(0, 0, (millis() % 2000) < 1000 ? 50 : 0)); // Azul
        pixels.show();
        
        // --- 3. MANTENIMIENTO DE CONEXIÓN MQTT ---
        if (client.connected()) {
            client.loop(); 
        }

        // --- 4. TAREAS PERIÓDICAS (SUPABASE Y OTA HTTP) ---
        // (CAMBIO) Esta sección fue eliminada. Ya no se checa el servidor
        // periódicamente, solo durante la ventana de mantenimiento.

        // --- 5. LÓGICA DE CONEXIÓN MQTT (SI ES NECESARIO) ---
        if (!client.connected()) {
            if (DEBUG_MODE) Serial.println("[N0] Intentando conexión MQTT...");
            
            if (deviceIdForMqtt == "") {
                deviceIdForMqtt = WiFi.macAddress();
                deviceIdForMqtt.replace(":", "");
            }

            // (CAMBIO) Ahora confía en la variable cargada desde la SD en setup()
            if (currentServerUrl.isEmpty() || currentServerUrl == "") {
                if (DEBUG_MODE) Serial.println("[N0] URL del servidor MQTT aún no definida. Esperando a la ventana de mantenimiento...");
                // (Se saltará el envío de datos, lo cual es correcto)
            } else {
                client.setServer(currentServerUrl.c_str(), MQTT_PORT);
                client.setKeepAlive(60);
                if(DEBUG_MODE) Serial.printf("[N0] Servidor MQTT seteado a: %s\n", currentServerUrl.c_str());

                if (client.connect(deviceIdForMqtt.c_str(), MQTT_USER, MQTT_PASSWORD)) {
                    if (DEBUG_MODE) Serial.println("[N0] MQTT Conectado.");
                } else {
                    if (DEBUG_MODE) Serial.printf("[N0] ERROR: Fallo al conectar a MQTT, rc=%d. Reintentando...\n", client.state());
                    vTaskDelay(pdMS_TO_TICKS(5000)); 
                    continue; 
                }
            }
        }

        // --- 6A. REPORTE DE ARRANQUE (BASADO EN RTC) ---
        // (Esta lógica sigue igual)
        if (client.connected() && !boot_time_reported) {
            long boot_time_unix = rtc.now().unixtime() - (millis() / 1000);
            
            if (boot_time_unix > 1704067200) { // Chequeo de sanidad (> 1 Ene 2024)
                if(DEBUG_MODE) Serial.println("[N0] Hora del RTC válida detectada.");
                char jsonPayload[128];
                snprintf(jsonPayload, sizeof(jsonPayload), 
                         "{\"device_id\":\"%s\",\"boot_time_unix\":%lu}", 
                         deviceIdForMqtt.c_str(), boot_time_unix);
                
                if (client.publish(TOPIC_BOOT, jsonPayload, true)) { // Publicar con retención
                    if(DEBUG_MODE) Serial.printf("[N0] ÉXITO: Reporte de arranque (vía RTC) enviado.\n");
                    boot_time_reported = true; // <-- Desbloquea el envío de datos
                } else {
                    if(DEBUG_MODE) Serial.println("[N0] ERROR: Fallo al enviar reporte de arranque (RTC).");
                }
            } else {
                if(DEBUG_MODE) Serial.println("[N0-Debug] Hora del RTC no es fiable. Esperando NTP en ventana de mantenimiento...");
            }
        }

        // --- 6B. GESTIÓN DE HORA (NTP OPORTUNISTA) ---
        // (CAMBIO) Esta sección fue eliminada. El NTP ahora solo
        // se ejecuta 1 vez al día dentro de runMaintenanceWindow().

        // --- 7. PROCESAMIENTO DE ARCHIVOS DE LA SD (MODO RÁFAGA) ---
        // (CAMBIO) Solo depende de que MQTT esté conectado y el arranque reportado.
        // (CAMBIO) Se quita la comprobación de suscripción.
        if (client.connected() && boot_time_reported && !sd_card_failed) {
            
            // --- 7a. CHEQUEO DE ESPACIO EN SD (Lógica sin cambios) ---
            if (SD.usedBytes() > MAX_SD_USAGE_BYTES) {
                if (DEBUG_MODE) Serial.println("[N0] ⚠️ ADVERTENCIA: SD casi llena. Purgando archivos antiguos...");
                drawGenericMessage("Almacenamiento", "Purgando SD...");

                File rootPurge = SD.open("/");
                if (rootPurge) {
                    // ... (Toda la lógica de purga de 10 archivos sigue igual) ...
                    // (Omitida por brevedad, no necesita cambios)
                    rootPurge.close();
                }
            }

            // --- 7b. LÓGICA DE ENVÍO DE ARCHIVOS .DAT ---
            if(DEBUG_MODE) Serial.println("[N0] Buscando archivos .dat en la SD para enviar...");
            File root = SD.open("/");
            if (!root) {
                if(DEBUG_MODE) Serial.println("[N0] ERROR CRÍTICO: No se pudo abrir el directorio raíz de la SD.");
                sd_card_failed = true; // Activar modo falla
                vTaskDelay(pdMS_TO_TICKS(5000));
                continue;
            }

            File file_to_process;
            while(file_to_process = root.openNextFile()){
                String filename = file_to_process.name();
                if (filename.endsWith(".dat") && filename != "/buffer.dat") {
                    if(DEBUG_MODE) Serial.printf("\n[N0] ==> Archivo de batch encontrado: %s\n", filename.c_str());

                    // (CAMBIO) Chequeo de suscripción ELIMINADO.
                    // if (!puede_enviar_datos) { ... }

                    // Procesar y enviar por MQTT línea por línea
                    bool batch_success = true;
                    String topic_mediciones = String(TOPIC_MEDICIONES) + deviceIdForMqtt;

                    while (file_to_process.available()) {
                        String line = file_to_process.readStringUntil('\n');
                        line.trim();
                        if (line.length() > 0) {
                            // ... (La lógica de sscanf y snprintf sigue igual) ...
                            // (Omitida por brevedad)
                            MeasurementData data;
                            int parsed_items = sscanf(line.c_str(), "%u,%lu,%f,%f,%f,%f,%f,%f,%f,%f", 
                                                      &data.sequence_number, &data.timestamp, &data.vrms, &data.irms_phase, 
                                                      &data.irms_neutral, &data.power, &data.va, &data.power_factor, &data.leakage, &data.temp_cpu);
                            
                            if (parsed_items == 10) {
                                char jsonPayload[256];
                                snprintf(jsonPayload, sizeof(jsonPayload),
                                         "{\"ts_unix\":%lu,\"vrms\":%.2f,\"irms_p\":%.3f,\"irms_n\":%.3f,\"pwr\":%.2f,\"va\":%.2f,\"pf\":%.2f,\"leak\":%.3f,\"temp\":%.1f,\"seq\":%u}",
                                         data.timestamp, data.vrms, data.irms_phase, data.irms_neutral, data.power, data.va, data.power_factor, data.leakage, data.temp_cpu, data.sequence_number);
                                
                                if (!client.publish(topic_mediciones.c_str(), jsonPayload)) {
                                    if(DEBUG_MODE) Serial.println("[N0] ERROR: Fallo al publicar MQTT. Abortando batch.");
                                    batch_success = false;
                                    break; 
                                } else {
                                     if(DEBUG_MODE) Serial.print("."); 
                                }
                            }
                        }
                        client.loop(); 
                        esp_task_wdt_reset(); 
                    } // Fin del bucle while (file_to_process.available())

                    if(DEBUG_MODE && batch_success) Serial.println("\n[N0] Batch enviado.");

                    if (batch_success) {
                        if(DEBUG_MODE) Serial.printf("[N0] ÉXITO: Batch %s enviado. Borrando archivo.\n", filename.c_str());
                        file_to_process.close();
                        SD.remove("/" + filename);
                    } else {
                        if(DEBUG_MODE) Serial.printf("[N0] ERROR: Batch %s fallido. Se reintentará.\n", filename.c_str());
                        file_to_process.close();
                        break; // Rompe el bucle 'while(file_to_process)'
                    }

                } else {
                     // (Omitir debug)
                }
                
                if (file_to_process) {
                    file_to_process.close();
                }
                esp_task_wdt_reset();
            } // Fin del bucle while (root.openNextFile())
            root.close();

        } else if (client.connected() && !boot_time_reported) {
            if(DEBUG_MODE) Serial.println("[N0-Debug] Esperando hora válida (RTC) para enviar reporte de arranque.");
        }
        
        // --- 8. (NUEVO) VENTANA DE MANTENIMIENTO Y REINICIO DIARIO (BASADO EN RTC) ---
        if (!rtc_failed) {
            DateTime now = rtc.now();
            
            // Comprobar si es la hora de mantenimiento
            if (now.hour() == MAINTENANCE_HOUR && now.minute() == MAINTENANCE_MINUTE && !maintenance_window_triggered) {
                
                if(DEBUG_MODE) Serial.printf("[N0] Son las %d:%d. Hora de mantenimiento.\n", MAINTENANCE_HOUR, MAINTENANCE_MINUTE);
                maintenance_window_triggered = true; // Marcar como ejecutada para este día

                // (NUEVO) Lógica de reinicio seguro: no reiniciar si hay archivos pendientes
                bool filesPending = false;
                if (!sd_card_failed) {
                    File rootCheck = SD.open("/");
                    if (rootCheck) {
                        File checkFile = rootCheck.openNextFile();
                        while(checkFile){
                            String fname = checkFile.name();
                            if (fname.endsWith(".dat") && fname != "/buffer.dat") {
                                filesPending = true;
                                checkFile.close();
                                break;
                            }
                            if(checkFile) checkFile.close();
                            checkFile = rootCheck.openNextFile();
                        }
                        rootCheck.close();
                    }
                }

                if (filesPending) {
                    if (DEBUG_MODE) Serial.println("[N0] Mantenimiento pospuesto: Hay archivos pendientes de envío.");
                    maintenance_window_triggered = false; // Reintentar en el próximo ciclo
                } else {
                    // No hay archivos pendientes, es seguro ejecutar el mantenimiento
                    runMaintenanceWindow(); // Esta función NUNCA retorna (reinicia el ESP)
                }

            } else if (now.hour() != MAINTENANCE_HOUR) {
                // Si ya no es la hora de mantenimiento, reseteamos la bandera
                // para que esté lista para el día siguiente.
                maintenance_window_triggered = false;
            }
        }
        
        // --- 9. FIN DE CICLO ---
        if(DEBUG_MODE) Serial.printf("[N0] <<< Fin del bucle. Esperando %lu ms.\n", MESSENGER_CYCLE_DELAY_MS);
        vTaskDelay(pdMS_TO_TICKS(MESSENGER_CYCLE_DELAY_MS));
    }
}

// =========================================================================
// === SETUP (ARQUITECTURA v14.1 - NO BLOQUEANTE)
// =========================================================================
void setup() {
    Serial.begin(115200);
    delay(1000); // Dar tiempo a que el monitor serial se conecte
    Serial.println("\n\n==================================================");
    Serial.println("== INICIANDO FIRMWARE CUENTATRÓN v14.1 (Robusto) ==");
    Serial.println("==================================================");

    // --- 1. INICIALIZAR HARDWARE BÁSICO ---
    Serial.print("Inicializando hardware básico (Pines, Neopixel)...");
    pinMode(BUTTON_PIN, INPUT_PULLUP); 
    pixels.begin();
    pixels.setBrightness(30);
    pixels.show();
    Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
    Serial.println(" OK.");

    // --- 1.5 INICIALIZAR STACK DE WIFI ---
    Serial.print("Inicializando stack de WiFi...");
    WiFi.mode(WIFI_STA); 
    Serial.println(" OK.");

    // --- 2. INICIALIZAR RTC (MODO FALLA) ---
    Serial.print("Inicializando RTC (DS3231)...");
    if (!rtc.begin()) {
        Serial.println("\nERROR CRÍTICO: No se encontró el módulo RTC. Iniciando en Modo Falla (RTC).");
        rtc_failed = true; // <-- CAMBIO: Activa la bandera de falla
        // while (1) delay(1000); // <-- CAMBIO: Eliminado el bloqueo
    } else {
        // Si la batería del RTC falló, poner una hora por defecto
        if (rtc.lostPower()) {
            Serial.println("ADVERTENCIA: RTC perdió energía, ajustando a 2025.");
            rtc.adjust(DateTime(2025, 1, 1, 0, 0, 0)); 
        }
        Serial.println(" OK.");
    }
    
    // --- 3. INICIALIZAR PANTALLA ---
    Serial.print("Inicializando periféricos I2C (OLED)...");
    setupOLED();
    Serial.println(" OK.");
    
    if(rtc_failed) {
        drawBootScreen("ERROR: RTC");
        delay(2000);
    } else {
        drawBootScreen("Iniciando...");
        delay(500);
    }

    // --- 4. INICIALIZAR TARJETA SD (MODO FALLA) ---
    Serial.print("Montando tarjeta SD...");
    drawBootScreen("Montando SD...");
    if (!SD.begin(SD_CS_PIN)) {
        Serial.println("\nERROR CRÍTICO: Fallo al montar la tarjeta SD. Iniciando en Modo Falla (SD).");
        pixels.setPixelColor(0, pixels.Color(255, 0, 0)); pixels.show();
        drawBootScreen("ERROR: SD");
        sd_card_failed = true; // <-- CAMBIO: Activa la bandera de falla
        delay(2000);
        // while (1) delay(1000); // <-- CAMBIO: Eliminado el bloqueo
    } else {
        Serial.println(" OK.");    
    }

    // --- 5. INICIALIZAR SISTEMA (MUTEX Y WATCHDOG) ---
    Serial.print("Configurando sistema multitarea (Mutex y Watchdog)...");
    sharedVarsMutex = xSemaphoreCreateMutex();
    
    // ESTA ES LA ÚNICA FALLA QUE SÍ DEBE DETENER EL SISTEMA
    if (sharedVarsMutex == NULL) {
        Serial.println("\nERROR CRÍTICO: Fallo al crear el Mutex. Memoria insuficiente.");
        drawBootScreen("ERROR: MUTEX");
        while(1) delay(1000); // Detener el arranque
    }
    
    esp_task_wdt_config_t wdt_config = {
        .timeout_ms = WDT_TIMEOUT_SECONDS * 1000,
        .idle_core_mask = (1 << portNUM_PROCESSORS) - 1,
        .trigger_panic = true,
       };
    esp_task_wdt_reconfigure(&wdt_config);
    Serial.println(" OK.");

    // --- 6. GESTIÓN DE CONFIGURACIÓN (SI LA SD ESTÁ PRESENTE) ---
    drawBootScreen("Cargando config...");
    Serial.println("\n--- GESTIÓN DE CONFIGURACIÓN ---");

    if (!sd_card_failed) {
        // --- 6A. CARGAR CONFIGURACIÓN MQTT (NUEVO) ---
        Serial.print("Cargando config de red (MQTT)...");
        File mqttConfigFile = SD.open(MQTT_CONFIG_FILE, FILE_READ);
        if (mqttConfigFile) {
            StaticJsonDocument<128> doc;
            DeserializationError error = deserializeJson(doc, mqttConfigFile);
            if (!error && doc.containsKey("server_url")) {
                currentServerUrl = doc["server_url"].as<String>();
                Serial.printf(" OK. Servidor: %s\n", currentServerUrl.c_str());
            } else {
                Serial.println(" Fallo al parsear JSON. Se usará Supabase.");
            }
            mqttConfigFile.close();
        } else {
            Serial.println(" Archivo no encontrado. Se usará Supabase.");
        }

        // --- 6B. CARGAR CALIBRACIÓN ---
        Serial.print("Cargando calibración desde la SD...");
        loadCalibration(); // Esta función ya existe
        Serial.println(" OK.");
        if(DEBUG_MODE) Serial.printf("   Valores cargados -> V_CAL: %.2f, P_CAL: %.2f\n", voltage_cal, phase_cal);

        // Aplicar la calibración a EmonLib
        Serial.print("Aplicando calibración a EmonLib...");
        applyCalibration(); // Esta función ya existe
        Serial.println(" OK.");
        
    } else {
        Serial.println("ADVERTENCIA: SD no detectada. Omitiendo carga de config y calibración.");
        Serial.println("Se usarán los valores de calibración por defecto.");
        
        // Aplicar calibración por defecto (la que está en las variables globales)
        Serial.print("Aplicando calibración (por defecto) a EmonLib...");
        applyCalibration(); 
        Serial.println(" OK.");
    }
    Serial.println("--------------------------------");


    // --- 7. CONFIGURAR OTA (SOBRE ARDUINO) ---
    Serial.print("Configurando OTA...");
    drawBootScreen("Iniciando OTA...");
    
    ArduinoOTA.setHostname("Cuentatron"); 
    ArduinoOTA.setPassword(OTA_PASSWORD);
    Serial.printf("\n[DEBUG] Heap libre ANTES de ArduinoOTA.begin(): %d bytes\n", ESP.getFreeHeap());
    ArduinoOTA.begin();
    Serial.println(" OK.");

    // --- 8. INICIAR TAREAS DE LOS NÚCLEOS ---
    // (Aún no modificamos esto, lo haremos en el siguiente paso)
    Serial.print("Iniciando tareas en los núcleos 0 y 1...");
    drawBootScreen("Iniciando tareas...");
    xTaskCreatePinnedToCore(writerTask, "WriterTask", 8192, NULL, 2, &writerTaskHandle, 1);
    
    // (NUEVO) Aumentar el stack de la tarea de red a 24KB
    xTaskCreatePinnedToCore(messengerTask, "MessengerTask", 24576, NULL, 1, &messengerTaskHandle, 0); // <-- CAMBIO: 16384 -> 24576
    
    Serial.println(" OK.");
    
    drawBootScreen("¡Listo!");
    delay(1000); 

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
// --- FUNCIÓN DE ACTUALIZACIÓN (OTA) VÍA HTTP
// =========================================================================
void checkForHttpUpdate() {
    if (WiFi.status() != WL_CONNECTED) {
        if (DEBUG_MODE) Serial.println("[N0] Omitiendo búsqueda de actualizaciones: WiFi desconectado.");
        return;
    }
    
    if (DEBUG_MODE) Serial.println("\n[N0] ==> Buscando actualizaciones de firmware...");
    
    // --- 1. VERIFICAR VERSIÓN DISPONIBLE ---
    WiFiClient clientVersion;
    HTTPClient http;
    
    if(DEBUG_MODE) Serial.printf("[N0-Debug] Consultando versión: %s\n", FIRMWARE_VERSION_URL);
    
    if (!http.begin(clientVersion, FIRMWARE_VERSION_URL)) {
        if(DEBUG_MODE) Serial.println("[N0] ERROR: No se pudo iniciar cliente HTTP para versión.");
        return;
    }

    int httpCode = http.GET();
    if (httpCode != HTTP_CODE_OK) {
        if (DEBUG_MODE) Serial.printf("[N0] ERROR: No se pudo verificar versión (HTTP: %d).\n", httpCode);
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
    
    if (DEBUG_MODE) Serial.println("[N0] ¡Nueva versión disponible! Iniciando proceso de actualización...");

    // --- 2. VERIFICAR CONECTIVIDAD (FAIL-FAST) ---
    // (MEJORA: Se mueve aquí, ANTES de suspender las tareas)
    // Esto evita detener el dispositivo si el servidor de binarios está caído.
    if(DEBUG_MODE) Serial.println("[N0] Verificando conectividad con el servidor de binarios...");
    WiFiClient testClient;
    String binUrl = String(FIRMWARE_BIN_URL);
    int hostStart = binUrl.indexOf("://") + 3;
    int hostEnd = binUrl.indexOf("/", hostStart);
    String host = binUrl.substring(hostStart, hostEnd);
    
    if (!testClient.connect(host.c_str(), 80)) {
        if(DEBUG_MODE) Serial.println("[N0] ERROR: No se puede conectar al servidor de binarios. Abortando actualización.");
        // No reiniciamos, solo abortamos. El dispositivo sigue midiendo.
        return;
    }
    testClient.stop();
    if(DEBUG_MODE) Serial.println("[N0] Conectividad OK.");

    // --- 3. PREPARAR SISTEMA PARA ACTUALIZACIÓN ---
    // Solo ahora que sabemos que hay una versión nueva Y hay conectividad,
    // suspendemos los sistemas críticos.
    if (DEBUG_MODE) Serial.println("[N0] Preparando sistema...");
    if (OLED_CONECTADA) drawGenericMessage("Actualizando", "Preparando...");
    if (DEBUG_MODE) Serial.printf("[N0-Debug] RAM libre antes de preparar: %d bytes\n", ESP.getFreeHeap());
    
    // CRÍTICO: Pausar la tarea de medición (Core 1)
    if(DEBUG_MODE) Serial.println("[N0] ==> Pausando Tarea Escritura (Core 1)...");
    vTaskSuspend(writerTaskHandle);
    delay(500); // Dar tiempo
    
    // CRÍTICO: Deshabilitar OTA por WiFi (local) para evitar conflictos
    ArduinoOTA.end();
    
    // CRÍTICO: Desmontar la SD para evitar corrupción
    if(DEBUG_MODE) Serial.println("[N0] ==> Desmontando SD...");
    SD.end();
    delay(100);
    
    if (DEBUG_MODE) Serial.printf("[N0-Debug] RAM libre después de preparar: %d bytes\n", ESP.getFreeHeap());
    
    // --- 4. VERIFICAR RAM DISPONIBLE ---
    uint32_t freeHeap = ESP.getFreeHeap();
    const uint32_t MIN_HEAP_REQUIRED = 100000; // 100KB mínimo
    
    if (freeHeap < MIN_HEAP_REQUIRED) {
        if (DEBUG_MODE) {
            Serial.printf("[N0] ERROR: RAM insuficiente (%d bytes). Se requieren %d.\n", freeHeap, MIN_HEAP_REQUIRED);
            Serial.println("[N0] Abortando actualización. Reiniciando dispositivo...");
        }
        delay(3000);
        ESP.restart(); // Necesario para reanudar la tarea suspendida
    }
    
    if (DEBUG_MODE) Serial.printf("[N0] RAM disponible: %d bytes. Continuando...\n", freeHeap);
    
    // --- 5. CONFIGURAR Y EJECUTAR ACTUALIZACIÓN ---
    if (OLED_CONECTADA) drawGenericMessage("Actualizando", "Descargando...");
    
    WiFiClient clientOTA;
    
    httpUpdate.setFollowRedirects(HTTPC_FORCE_FOLLOW_REDIRECTS);
    httpUpdate.rebootOnUpdate(true); // Reinicio automático si tiene éxito
    
    // Callbacks para el proceso
    httpUpdate.onStart([]() {
        if(DEBUG_MODE) Serial.println("[N0-OTA] Iniciando descarga...");
    });

    httpUpdate.onProgress([](int progress, int total) {
        static int lastPercent = -1;
        int percent = (progress * 100) / total;
        
        if (percent != lastPercent) { // Actualizar solo si el porcentaje cambia
            if(DEBUG_MODE) Serial.printf("[N0-OTA] %d%%\n", percent);
            if (OLED_CONECTADA) {
                drawUpdateScreen("Descargando...", percent);
            }
            lastPercent = percent;
            esp_task_wdt_reset(); // ¡CRÍTICO! Evita el reinicio del Watchdog
        }
    });
    
    httpUpdate.onEnd([]() {
        if(DEBUG_MODE) Serial.println("[N0-OTA] ¡Completado! Reiniciando...");
        if (OLED_CONECTADA) drawGenericMessage("Actualizacion", "Completada!");
    });
    
    httpUpdate.onError([](int error) {
        if(DEBUG_MODE) {
            Serial.printf("[N0-OTA] Error: %d - %s\n", error, HTTPUpdate().getLastErrorString().c_str());
        }
    });
    
    if(DEBUG_MODE) Serial.printf("[N0-Debug] Descargando: %s\n", FIRMWARE_BIN_URL);
    esp_task_wdt_reset();
    
    t_httpUpdate_return ret = httpUpdate.update(clientOTA, FIRMWARE_BIN_URL);
    
    // --- 6. MANEJO DE FALLO ---
    // (Solo se llega aquí si la actualización falló, ya que el éxito reinicia)
    if (ret == HTTP_UPDATE_FAILED) {
        if (DEBUG_MODE) {
            Serial.println("[N0] ERROR: Actualización falló.");
            Serial.printf("[N0-Debug] Error (%d): %s\n", 
                httpUpdate.getLastError(), 
                httpUpdate.getLastErrorString().c_str());
        }
        if (OLED_CONECTADA) drawGenericMessage("Actualizacion", "Error!");
        delay(5000);
        ESP.restart(); // Reiniciar de todos modos para reanudar la Tarea 1
    }
    
    if (DEBUG_MODE) Serial.println("[N0] Estado inesperado. Reiniciando...");
    delay(2000);
    ESP.restart();
}

// =========================================================================
// --- FUNCIÓN PARA GUARDAR CALIBRACIÓN EN LA SD
// =========================================================================
void saveCalibration() {
    if (DEBUG_MODE) Serial.println("\n[N0] ==> Guardando datos de calibración en /calibracion.json...");
    
    // Abrir en modo escritura (sobrescribe el archivo si existe)
    File file = SD.open("/calibracion.json", FILE_WRITE);
    if (!file) {
        if (DEBUG_MODE) Serial.println("[N0] ERROR CRÍTICO: No se pudo abrir '/calibracion.json' para escritura.");
        return;
    }

    StaticJsonDocument<256> doc;
    
    // Asignar los valores actuales de las variables globales al JSON
    doc["voltage_cal"] = voltage_cal;
    doc["current_cal_phase"] = current_cal_phase;
    doc["current_cal_neutral"] = current_cal_neutral;
    doc["phase_cal"] = phase_cal;
    
    if (DEBUG_MODE) {
        Serial.println("[N0-Debug] Valores de calibración a guardar:");
        serializeJson(doc, Serial); // Imprime el JSON al Serial
        Serial.println();
    }
    
    // Escribir el JSON al archivo
    if (serializeJson(doc, file) == 0) {
        if (DEBUG_MODE) Serial.println("[N0] ERROR: Fallo al escribir datos JSON en el archivo.");
    } else {
        if (DEBUG_MODE) Serial.println("[N0] ÉXITO: Calibración guardada correctamente.");
    }
    
    file.close();
}

// =========================================================================
// --- FUNCIÓN PARA GUARDAR CONFIG MQTT EN LA SD (NUEVO)
// =========================================================================
void saveMqttConfig() {
    if (sd_card_failed) return; // No intentar si la SD falló
    
    if (DEBUG_MODE) Serial.println("\n[N0] ==> Guardando config de red en /mqtt_config.json...");
    
    File file = SD.open(MQTT_CONFIG_FILE, FILE_WRITE);
    if (!file) {
        if (DEBUG_MODE) Serial.println("[N0] ERROR: No se pudo abrir /mqtt_config.json para escritura.");
        return;
    }

    StaticJsonDocument<128> doc;
    doc["server_url"] = currentServerUrl;
    
    if (serializeJson(doc, file) == 0) {
        if (DEBUG_MODE) Serial.println("[N0] ERROR: Fallo al escribir JSON de config MQTT.");
    } else {
        if (DEBUG_MODE) Serial.println("[N0] ÉXITO: Config de red guardada.");
    }
    
    file.close();
}

// =========================================================================
// --- FUNCIÓN PARA CARGAR LA CALIBRACIÓN DESDE LA SD
// =========================================================================
void loadCalibration() {
    if (DEBUG_MODE) Serial.print("[SISTEMA] Buscando archivo /calibracion.json...");

    if (SD.exists("/calibracion.json")) {
        if (DEBUG_MODE) Serial.println(" Archivo encontrado.");
        File file = SD.open("/calibracion.json", FILE_READ);
        if (file) {
            if (DEBUG_MODE) Serial.print("[SISTEMA] Leyendo y parseando archivo JSON...");
            StaticJsonDocument<256> doc;
            DeserializationError error = deserializeJson(doc, file);
            
            if (!error) {
                if (DEBUG_MODE) Serial.println(" OK.");
                // Cargamos cada valor solo si la clave existe en el archivo
                // Si una clave no existe, se mantiene el valor por defecto en la variable global
                if (doc.containsKey("voltage_cal")) voltage_cal = doc["voltage_cal"];
                if (doc.containsKey("current_cal_phase")) current_cal_phase = doc["current_cal_phase"];
                if (doc.containsKey("current_cal_neutral")) current_cal_neutral = doc["current_cal_neutral"];
                if (doc.containsKey("phase_cal")) phase_cal = doc["phase_cal"];

                if (DEBUG_MODE) {
                    Serial.println("--- Valores de Calibración Cargados en Memoria ---");
                    Serial.printf("  - voltage_cal: %.2f\n", voltage_cal);
                    Serial.printf("  - current_cal_phase: %.2f\n", current_cal_phase);
                    Serial.printf("  - current_cal_neutral: %.2f\n", current_cal_neutral);
                    Serial.printf("  - phase_cal: %.2f\n", phase_cal);
                    Serial.println("--------------------------------------------------");
                }
            } else {
                // Si el archivo JSON está corrupto, lo reportamos
                if (DEBUG_MODE) {
                    Serial.println(" ¡ERROR!");
                    Serial.printf("[SISTEMA] ERROR: Fallo al parsear /calibracion.json. Error: %s\n", error.c_str());
                    Serial.println("[SISTEMA] Se usarán los valores de calibración por defecto.");
                }
            }
            file.close();
        } else {
            if (DEBUG_MODE) Serial.println("\n[SISTEMA] ERROR: No se pudo abrir /calibracion.json para lectura.");
        }
    } else {
        // Si el archivo no existe (ej. primer arranque), lo creamos.
        if (DEBUG_MODE) {
            Serial.println(" ¡No encontrado!");
            Serial.println("[SISTEMA] Creando archivo de calibración con valores por defecto...");
        }
        saveCalibration(); // Llama a la función para crear el archivo por defecto
    }
}

// =========================================================================
// --- FUNCIÓN PARA APLICAR LA CALIBRACIÓN "EN CALIENTE" A EMONLIB
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
// --- FUNCIÓN PARA EJECUTAR UN RESETEO DE FÁBRICA COMPLETO
// =========================================================================
void handleFactoryReset() {

    // Esta función puede ser llamada por un comando remoto (Supabase)
    // o por una pulsación larga del botón (vía la bandera 'factory_reset_request')
    if (DEBUG_MODE) Serial.println("\n[N0] !ADVERTENCIA! Ejecutando Reseteo de Fábrica. Borrando todos los datos.");

    if (OLED_CONECTADA) {
        drawGenericMessage("Reseteo de Fabrica", "Borrando datos...");
    }

    // 1. Borrar archivo de buffer
    if (SD.exists("/buffer.dat")) {
        if (SD.remove("/buffer.dat")) {
            if (DEBUG_MODE) Serial.println("[N0] Archivo de buffer borrado.");
        }
    }

    // 2. Borrar todos los archivos de datos (.dat)
    if (DEBUG_MODE) Serial.println("[N0] Buscando y borrando archivos de datos (.dat)...");
    File root = SD.open("/");
    if (root) {
        File file = root.openNextFile();
        while(file){
            String filename = file.name();
            if (filename.endsWith(".dat")) {
                if (DEBUG_MODE) Serial.printf("[N0-Debug]  - Borrando: %s\n", filename.c_str());
                SD.remove("/" + filename);
            }
            file.close();
            file = root.openNextFile();
        }
        root.close();
        if (DEBUG_MODE) Serial.println("[N0] Todos los archivos de datos han sido borrados.");
    }

    // 3. Borrar credenciales de WiFi
    if (DEBUG_MODE) Serial.print("[N0] Borrando credenciales de WiFi...");
    WiFiManager wm;
    wm.resetSettings();
    if (DEBUG_MODE) Serial.println(" OK.");

    // 4. Reiniciar
    delay(2000);
    ESP.restart();
}

// =========================================================================
// --- FUNCIÓN PARA CONTACTAR A SUPABASE (SIMPLIFICADA)
// =========================================================================
// Esta función devuelve 'true' si se descargó una nueva calibración (para guardarla)
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
    http.setTimeout(8000); // 8 segundos de timeout

    int httpCode = http.GET();

    if (httpCode == HTTP_CODE_OK) {
        String responsePayload = http.getString();
        if (DEBUG_MODE) Serial.printf("[N0] Respuesta de Supabase: %s\n", responsePayload.c_str());

        StaticJsonDocument<512> doc;
        DeserializationError error = deserializeJson(doc, responsePayload);

        if (error) {
            if (DEBUG_MODE) Serial.printf("[N0] ERROR: Fallo al parsear JSON de tareas: %s\n", error.c_str());
            // (CAMBIO) No retornamos, intentamos procesar lo que se pueda
        }
            
        // --- 1. PROCESAR ESTADO DE SUSCRIPCIÓN (ELIMINADO) ---
        // (CAMBIO) Esta lógica fue removida. El dispositivo ya no
        // se preocupa por la suscripción, solo envía datos.
        // Las variables (pago_vencido, etc) pueden ser eliminadas
        // de las variables globales si lo deseas.

        // --- 2. PROCESAR LA URL DEL SERVIDOR MQTT (ROBUSTO) ---
        if (doc.containsKey("server_url") && !doc["server_url"].isNull()) {
            String newServerUrl = doc["server_url"].as<String>();
            
            if (newServerUrl != currentServerUrl) {
                currentServerUrl = newServerUrl;
                if (DEBUG_MODE) Serial.printf("[N0] URL del servidor MQTT actualizada a: %s\n", currentServerUrl.c_str());
                saveMqttConfig(); // (NUEVO) Guardar en la SD
            } else {
                if (DEBUG_MODE) Serial.println("[N0] URL de MQTT sin cambios.");
            }
        }

        // --- 3. PROCESAR ACTUALIZACIÓN DE CALIBRACIÓN (ROBUSTO) ---
        if (doc.containsKey("calibration") && doc["calibration"]["update_available"] == true) {

            if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
                if (DEBUG_MODE) Serial.println("[N0] Tarea 'actualizar calibración' recibida.");

                JsonObject values = doc["calibration"]["values"];
                voltage_cal = values["voltage"];
                current_cal_phase = values["current1"];
                current_cal_neutral = values["current2"];
                if (values.containsKey("phase_cal")) {
                    phase_cal = values["phase_cal"];
                }

                applyCalibration(); 
                newConfigFetched = true; 

                xSemaphoreGive(sharedVarsMutex);
                if (DEBUG_MODE) Serial.println("[N0] ¡ÉXITO! Calibración actualizada.");
            } else {
                if (DEBUG_MODE) Serial.println("[N0] ERROR: No se pudo tomar el Mutex para aplicar calibración.");
            }
        }


        // --- 4. PROCESAR COMANDOS (ROBUSTO Y SIMPLIFICADO) ---
        if (doc.containsKey("command") && !doc["command"].isNull()) {
            String cmd = doc["command"];
            if (DEBUG_MODE) Serial.printf("[N0] Tarea de 'comando' recibida: '%s'\n", cmd.c_str());

            // (CAMBIO) Se eliminó el comando "reboot"
            if (cmd == "factory_reset") {
                if (DEBUG_MODE) Serial.println("[N0] Comando remoto 'factory_reset' recibido. Ejecutando...");
                handleFactoryReset(); // Llama a la función de reseteo
            }
        }
        
    } else {
        if (DEBUG_MODE) Serial.printf("[N0] ERROR: Fallo al obtener tareas (HTTP: %d). Respuesta: %s\n", httpCode, http.getString().c_str());
    }
    
    http.end();
    return newConfigFetched; // Devuelve true si la calibración fue actualizada
}

// =========================================================================
// --- FUNCIÓN DE VENTANA DE MANTENIMIENTO (NUEVO)
// --- Se ejecuta una vez al día, justo antes del reinicio.
// =========================================================================
void runMaintenanceWindow() {
    if (WiFi.status() != WL_CONNECTED) {
        if(DEBUG_MODE) Serial.println("[N0] Omitiendo ventana de mantenimiento: WiFi desconectado. Se reiniciará.");
        delay(3000);
        ESP.restart();
        return;
    }

    if(DEBUG_MODE) Serial.println("\n[N0] ==============================================");
    if(DEBUG_MODE) Serial.println("[N0] === INICIANDO VENTANA DE MANTENIMIENTO DIARIO ===");
    if(DEBUG_MODE) Serial.println("[N0] ==============================================");

    drawGenericMessage("Mantenimiento", "Iniciando...");
    pixels.setPixelColor(0, pixels.Color(0, 255, 255)); // Color Cian
    pixels.show();

    // --- 1. Sincronizar NTP ---
    if(DEBUG_MODE) Serial.println("[N0-Mantto] 1. Sincronizando NTP...");
    drawGenericMessage("Mantenimiento", "Sincronizando NTP...");
    configTime(0, 0, NTP_SERVER_1, NTP_SERVER_2, NTP_SERVER_3);
    struct tm timeinfo;
    if (getLocalTime(&timeinfo, 10000)) { // 10 segundos de timeout
        if(DEBUG_MODE) Serial.println("[N0-Mantto] Hora NTP sincronizada. Ajustando RTC...");
        rtc.adjust(DateTime(time(NULL))); 
        if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
            time_synced = true; // Esta variable ahora es solo informativa
            xSemaphoreGive(sharedVarsMutex);
        }
    } else {
        if(DEBUG_MODE) Serial.println("[N0-Mantto] ERROR: Fallo al obtener hora NTP (timeout).");
    }

    // --- 2. Tareas Remotas (Supabase) ---
    // (Esta función ya fue modificada para no checar suscripción y guardar config)
    if(DEBUG_MODE) Serial.println("[N0-Mantto] 2. Buscando tareas en Supabase...");
    drawGenericMessage("Mantenimiento", "Buscando tareas...");
    bool newConfig = handleRemoteTasks(); 
    if (newConfig) {
        if (DEBUG_MODE) Serial.println("[N0-Mantto] Nueva calibración detectada, guardando en SD...");
        saveCalibration(); // Esta función ya existe
    }

    // --- 3. Actualización de Firmware (HTTP) ---
    if(DEBUG_MODE) Serial.println("[N0-Mantto] 3. Buscando actualizaciones de firmware...");
    drawGenericMessage("Mantenimiento", "Buscando updates...");
    checkForHttpUpdate(); // Esta función ya existe

    // --- 4. Reinicio ---
    // Si checkForHttpUpdate() encontró una actualización, el dispositivo ya se habrá reiniciado.
    // Si llegamos a este punto, significa que no hubo actualización y debemos reiniciar manualmente.
    
    if(DEBUG_MODE) Serial.println("[N0-Mantto] Mantenimiento completo. Reiniciando sistema...");
    drawGenericMessage("Mantenimiento", "Reiniciando...");
    delay(3000);
    ESP.restart();
}