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
const unsigned long SCREEN_CONSUMPTION_INTERVAL_MS = 30000;
const unsigned long SCREEN_OTHER_INTERVAL_MS = 15000;
const unsigned long NTP_RETRY_INTERVAL_MS = 120 * 1000;
const unsigned long SERVER_CHECK_INTERVAL_MS = 30 * 60 * 1000UL;
const unsigned long MESSENGER_CYCLE_DELAY_MS = 5000;
#define WDT_TIMEOUT_SECONDS 180
#define LONG_PRESS_DURATION_MS 10000
const unsigned long DAILY_RESTART_INTERVAL_MS = 24 * 3600 * 1000UL; // 24 horas

// --- 5. CONFIGURACIÓN DE RED ---
const char* NTP_SERVER_1 = "pool.ntp.org";
const char* NTP_SERVER_2 = "mx.pool.ntp.org";
const char* NTP_SERVER_3 = "time.google.com";

// --- 6. OBJETOS Y VARIABLES GLOBALES ---

// Objetos de Hardware
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
Adafruit_NeoPixel pixels(NUM_PIXELS, NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);
EnergyMonitor emon_phase;
EnergyMonitor emon_neutral;
RTC_DS3231 rtc;
unsigned long last_reboot_check_time = 0;

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
// === TAREA 1: ESCRITOR (NÚCLEO 1) - 100% AUTÓNOMO
// === Misión: Medir y guardar en SD. Sin dependencias de red.
// =========================================================================
void writerTask(void * pvParameters) {
    if(DEBUG_MODE) Serial.println("[N1] Tarea de Escritura iniciada en Núcleo 1.");
    esp_task_wdt_add(NULL);
    
    // El retraso de 60s fue eliminado.
    // La estabilización se maneja descartando las primeras lecturas.
    if(DEBUG_MODE) Serial.println("[N1] Iniciando bucle principal de medición.");

    unsigned long last_measurement_time = 0;
    const int lecturas_a_descartar = 5;
    int lecturas_descartadas = 0;
    
    for (;;) { // <-- INICIO DEL BUCLE INFINITO PRINCIPAL
        esp_task_wdt_reset();
        unsigned long currentMillis = millis();

        // --- 1. SECCIÓN DE MEDICIÓN Y GUARDADO ---
        if (currentMillis - last_measurement_time >= MEASUREMENT_INTERVAL_MS) {
            last_measurement_time = currentMillis;
            if(DEBUG_MODE) Serial.println("\n[N1] ==> Iniciando ciclo de medición...");

            // Realizar cálculos de EmonLib
            emon_phase.calcVI(20, 2000);
            emon_neutral.calcVI(20, 2000);

            if (lecturas_descartadas < lecturas_a_descartar) {
                lecturas_descartadas++;
                if(DEBUG_MODE) Serial.printf("[N1] Descartando lectura de estabilización %d de %d.\n", lecturas_descartadas, lecturas_a_descartar);
            } else {
                
                // Si es la primera lectura válida, notificar
                if(DEBUG_MODE && lecturas_descartadas == lecturas_a_descartar) {
                    Serial.println("[N1] Estabilización completa. Empezando a procesar y guardar datos.");
                    lecturas_descartadas++; // Evita que este mensaje se repita
                }
                
                MeasurementData data;
                data.sequence_number = ++global_sequence_number;
                // ¡Correcto! Usar el timestamp Unix del RTC
                data.timestamp = rtc.now().unixtime(); 
                data.vrms = emon_phase.Vrms;
                data.irms_phase = emon_phase.Irms;
                data.irms_neutral = emon_neutral.Irms;
                data.power = emon_phase.realPower;
                data.va = emon_phase.apparentPower;
                data.power_factor = emon_phase.powerFactor;
                data.leakage = fabs(data.irms_phase - data.irms_neutral);
                data.temp_cpu = temperatureRead();

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

                // (Optimización) Imprimir solo en modo DEBUG, ya que Serial es lento
                if(DEBUG_MODE) {
                    Serial.printf("[N1] RMS -> V:%.1f, A_Fase:%.3f, A_Neutro:%.3f, W:%.0f, VA:%.0f, FP:%.2f, Fuga:%.3f, Temp:%.1fC\n",
                                    data.vrms, data.irms_phase, data.irms_neutral, data.power, data.va, data.power_factor, data.leakage, data.temp_cpu);
                }
                
                // Guardar en la SD (siempre, sin condiciones de red)
                if(DEBUG_MODE) Serial.println("[N1-Debug] Procediendo a guardar en SD.");
                File dataFile = SD.open("/buffer.dat", FILE_APPEND);
                if (dataFile) {
                    // El formato CSV de 10 campos con timestamp Unix
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
                    
                    // Si el buffer está lleno, renombrarlo a un archivo .dat
                    if (lines_in_buffer >= BATCH_SIZE) {
                        // El nombre del archivo usará el timestamp Unix (RTC) de la última medición
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
        
        // --- 2. SECCIÓN DE GESTIÓN DE PANTALLA Y BOTÓN ---
        if (digitalRead(BUTTON_PIN) == LOW) {
            if (!button_is_pressed) {
                button_press_start_time = currentMillis;
                button_is_pressed = true;
            } else if (currentMillis - button_press_start_time > LONG_PRESS_DURATION_MS) {
                
                // --- ¡CORRECCIÓN CRÍTICA DE BUG! ---
                // El Núcleo 1 NO DEBE manejar el WiFi.
                // Solo notificamos al Núcleo 0 para que él lo haga.
                drawGenericMessage("Reseteo WiFi", "Solicitado...");
                pixels.setPixelColor(0, pixels.Color(255, 0, 255)); pixels.show();
                
                // (Debes añadir esta variable global en la Parte 1)
                // volatile bool factory_reset_request = false;
                factory_reset_request = true; 
                
                button_is_pressed = false; // Evita que se repita la solicitud
                delay(2000); // Pausa para que el usuario vea el mensaje
            }
        } else {
            if (button_is_pressed) {
                // Si el botón se soltó ANTES del tiempo de reseteo, es un clic corto
                if(currentMillis - button_press_start_time < LONG_PRESS_DURATION_MS) {
                    // (Corrección de Bug Menor) Cambiado de % 4 a % 3
                    screen_mode = (screen_mode + 1) % 3; 
                    last_screen_change_time = currentMillis;
                }
            }
            button_is_pressed = false;
        }

        // Lógica de rotación de pantalla
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
        
        vTaskDelay(pdMS_TO_TICKS(50)); // Ceder tiempo al OS
    } // <-- FIN DEL BUCLE INFINITO PRINCIPAL
}

// =========================================================================
// === TAREA 2: MENSAJERO (NÚCLEO 0) - OPORTUNISTA
// === Misión: Gestionar WiFi, NTP, Supabase, OTA y MQTT.
// =========================================================================
void messengerTask(void * pvParameters) {
    if(DEBUG_MODE) Serial.println("[N0] Tarea de Mensajero iniciada en Núcleo 0.");
    esp_task_wdt_add(NULL);
    
    unsigned long last_server_check = 0;
    unsigned long last_ntp_attempt = 0;

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
            if (DEBUG_MODE) Serial.println("[N0] Reseteo de WiFi solicitado por el Núcleo 1. Borrando credenciales...");
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
                Serial.println("[N0] No hay credenciales WiFi. Iniciará el portal de configuración.");
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
                // Si hay credenciales, solo reintenta la conexión
                if(DEBUG_MODE) Serial.println("[N0] Intentando reconexión a red guardada...");
                WiFi.reconnect();
            }
            
            /* * NOTA: El código de re-sincronización de 7 días estaba aquí (sección 9 original),
             * lo cual era un bug, ya que solo se ejecutaría si el WiFi ESTABA DESCONECTADO.
             * Se movió a la nueva Sección 6B, donde se ejecuta correctamente.
            */
            vTaskDelay(pdMS_TO_TICKS(MESSENGER_CYCLE_DELAY_MS)); 
            continue; // Vuelve al inicio del bucle for(;;)
        }
        
        // Si llegamos aquí, el WiFi está CONECTADO
        pixels.setPixelColor(0, pixels.Color(0, 0, (millis() % 2000) < 1000 ? 50 : 0)); // Azul
        pixels.show();
        
        // --- 3. MANTENIMIENTO DE CONEXIÓN MQTT ---
        // (Corrección de estabilidad: Llamar a loop() en cada ciclo para keep-alive)
        if (client.connected()) {
            client.loop(); 
        }

        // --- 4. TAREAS PERIÓDICAS (SUPABASE Y OTA HTTP) ---
        if (millis() - last_server_check > SERVER_CHECK_INTERVAL_MS || last_server_check == 0) {
            if(DEBUG_MODE) Serial.println("[N0] Chequeando servidor (Supabase/OTA)...");
            bool newConfig = handleRemoteTasks();
            if (newConfig) {
                if (DEBUG_MODE) Serial.println("[N0] Nueva configuración remota detectada, guardando en SD...");
                saveCalibration();
            }
            checkForHttpUpdate(); // Chequeo de nueva versión de firmware
            last_server_check = millis();
        }

        // --- 5. LÓGICA DE CONEXIÓN MQTT (SI ES NECESARIO) ---
        if (!client.connected()) {
            if (DEBUG_MODE) Serial.println("[N0] Intentando conexión MQTT...");
            
            if (deviceIdForMqtt == "") {
                deviceIdForMqtt = WiFi.macAddress();
                deviceIdForMqtt.replace(":", "");
            }

            // (Lógica v14.0) Esperar a tener la URL de Supabase
            if (currentServerUrl.isEmpty() || currentServerUrl == "") {
                if (DEBUG_MODE) Serial.println("[N0] URL del servidor MQTT aún no definida. Esperando ciclo de handleRemoteTasks().");
            } else {
                // (Corrección v14.0) Setear el servidor CADA VEZ que intentamos conectar.
                client.setServer(currentServerUrl.c_str(), MQTT_PORT);
                client.setKeepAlive(60);
                if(DEBUG_MODE) Serial.printf("[N0] Servidor MQTT seteado a: %s\n", currentServerUrl.c_str());

                if (client.connect(deviceIdForMqtt.c_str(), MQTT_USER, MQTT_PASSWORD)) {
                    if (DEBUG_MODE) Serial.println("[N0] MQTT Conectado.");
                } else {
                    if (DEBUG_MODE) Serial.printf("[N0] ERROR: Fallo al conectar a MQTT, rc=%d. Reintentando...\n", client.state());
                    vTaskDelay(pdMS_TO_TICKS(5000)); // Esperar 5s antes de reintentar el bucle
                    continue; 
                }
            }
        }

        // =========================================================================
        // --- INICIO DE LA LÓGICA DE TIEMPO Y ENVÍO (v14.1 - RTC-FIRST) ---
        // =========================================================================

        // --- 6A. REPORTE DE ARRANQUE (BASADO EN RTC) ---
        // Misión: Enviar el reporte de arranque tan pronto como sea posible
        // usando la hora del RTC, sin depender de NTP.
        // Esto desbloquea el envío de datos de la SD.
        if (client.connected() && !boot_time_reported) {
            
            // ¡Usar la hora del RTC! Es la más fiable que tenemos al arrancar.
            // Se resta millis() para obtener el timestamp de cuando el ESP32 *realmente* arrancó.
            long boot_time_unix = rtc.now().unixtime() - (millis() / 1000);
            
            // Chequeo de sanidad: Asegura que la hora del RTC es válida (ej. > 1 Enero 2024)
            // 1704067200 es el timestamp de 2024-01-01 00:00:00 GMT
            if (boot_time_unix > 1704067200) { 
                if(DEBUG_MODE) Serial.println("[N0] Hora del RTC válida detectada.");
                char jsonPayload[128];
                snprintf(jsonPayload, sizeof(jsonPayload), 
                         "{\"device_id\":\"%s\",\"boot_time_unix\":%lu}", 
                         deviceIdForMqtt.c_str(), boot_time_unix);
                
                if (client.publish(TOPIC_BOOT, jsonPayload, true)) { // Publicar con retención
                    if(DEBUG_MODE) Serial.printf("[N0] ÉXITO: Reporte de arranque (vía RTC) enviado: %s\n", jsonPayload);
                    boot_time_reported = true; // <-- ¡CRÍTICO! ESTO DESBLOQUEA EL ENVÍO DE DATOS
                } else {
                    if(DEBUG_MODE) Serial.println("[N0] ERROR: Fallo al enviar reporte de arranque (RTC).");
                }
            } else {
                if(DEBUG_MODE) Serial.println("[N0-Debug] Hora del RTC no es fiable (batería agotada?). Esperando NTP para reporte de arranque...");
                // Si la hora del RTC no es válida, esperará a que el bloque 6B (NTP) funcione.
            }
        }

        // --- 6B. GESTIÓN DE HORA (NTP OPORTUNISTA) ---
        // Misión: Sincronizar NTP en segundo plano para ajustar el RTC,
        // sin bloquear el funcionamiento principal.
        
        bool needs_ntp_sync = !time_synced; // Si nunca ha sincronizado en este arranque
        
        // (Corrección de Bug v14.1)
        // Se define la constante aquí, ya que en el código original estaba
        // dentro de un 'if' y no era accesible globalmente.
        const unsigned long NTP_RESYNC_INTERVAL_MS = 7 * 24 * 3600 * 1000UL; // 7 días

        // Chequeo de re-sincronización periódica (cada 7 días)
        if (time_synced && (millis() - last_ntp_attempt > NTP_RESYNC_INTERVAL_MS)) {
             if (DEBUG_MODE) Serial.println("[N0] Forzando re-sincronización de NTP para corregir drift del RTC...");
             if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                 time_synced = false; // Bajar la bandera para forzar el bloque NTP
                 xSemaphoreGive(sharedVarsMutex);
             }
             needs_ntp_sync = true;
        }

        // (Solo corre si necesita sincronizar Y ha pasado el intervalo de reintento)
        if (needs_ntp_sync && millis() - last_ntp_attempt > NTP_RETRY_INTERVAL_MS) {
            last_ntp_attempt = millis(); // Marcar el intento, incluso si falla
            if(DEBUG_MODE) Serial.println("[N0] ==> Intentando sincronizar/ajustar NTP (en segundo plano)...");
            configTime(0, 0, NTP_SERVER_1, NTP_SERVER_2, NTP_SERVER_3);
            struct tm timeinfo;
            
            if (getLocalTime(&timeinfo, 5000)) { // 5 segundos de timeout
                if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                    time_synced = true;
                    xSemaphoreGive(sharedVarsMutex);
                }
                if(DEBUG_MODE) Serial.println("[N0] Hora NTP sincronizada con éxito.");

                // AJUSTE OPORTUNISTA DEL RTC
                if(DEBUG_MODE) Serial.println("[N0] Ajustando RTC (DS3231) con la hora NTP...");
                rtc.adjust(DateTime(time(NULL))); 

                // Si el reporte de arranque (6A) falló antes por culpa de un RTC sin batería,
                // ahora se re-intentará en el siguiente ciclo.
                
            } else {
                if(DEBUG_MODE) Serial.println("[N0] ERROR: Fallo al obtener hora NTP (timeout). El dispositivo continuará con la hora del RTC.");
            }
        }

        // --- 7. PROCESAMIENTO DE ARCHIVOS DE LA SD (MODO RÁFAGA) ---
        // (Ahora solo depende de 'boot_time_reported', que se activa en 6A con el RTC)
        if (client.connected() && boot_time_reported) {
            // --- 7a. CHEQUEO DE ESPACIO EN SD ---
            const uint64_t MAX_SD_USAGE_BYTES = 50ULL * 1024ULL * 1024ULL;
            const int FILES_TO_PURGE = 10; 

            if (SD.usedBytes() > MAX_SD_USAGE_BYTES) {
                if (DEBUG_MODE) Serial.println("[N0] ⚠️ ADVERTENCIA: SD casi llena. Purgando archivos antiguos...");

                File rootPurge = SD.open("/");
                if (rootPurge) {
                    File fileToPurge;
                    char oldestFiles[FILES_TO_PURGE][20]; 
                    uint32_t oldestTimestamps[FILES_TO_PURGE];

                    for(int i=0; i<FILES_TO_PURGE; i++) {
                        oldestTimestamps[i] = UINT32_MAX;
                        strcpy(oldestFiles[i], "");
                    }

                    while(fileToPurge = rootPurge.openNextFile()) {
                        String nameStr = fileToPurge.name();
                        const char* name = nameStr.c_str();

                        if (strstr(name, ".dat") && !strstr(name, "buffer.dat")) {
                            uint32_t timestamp = strtoul(name + 1, NULL, 10);
                            if (timestamp > 0) {
                                for(int i=0; i<FILES_TO_PURGE; i++) {
                                    if (timestamp < oldestTimestamps[i]) {
                                        for (int j = FILES_TO_PURGE - 1; j > i; j--) {
                                            oldestTimestamps[j] = oldestTimestamps[j-1];
                                            strcpy(oldestFiles[j], oldestFiles[j-1]);
                                        }
                                        oldestTimestamps[i] = timestamp;
                                        strcpy(oldestFiles[i], name);
                                        break;
                                    }
                                }
                            }
                        }
                        fileToPurge.close();
                    }
                    rootPurge.close();

                    if(DEBUG_MODE) Serial.println("[N0] Borrando los 10 archivos más antiguos...");
                    for(int i=0; i<FILES_TO_PURGE; i++) {
                        if (strlen(oldestFiles[i]) > 0) {
                            if(DEBUG_MODE) Serial.printf("   - Purgando: %s\n", oldestFiles[i]);
                            SD.remove(oldestFiles[i]);
                        }
                    }
                }
            }

            // --- 7b. LÓGICA DE ENVÍO DE ARCHIVOS .DAT ---
            if(DEBUG_MODE) Serial.println("[N0] Buscando archivos .dat en la SD para enviar...");
            File root = SD.open("/");
            if (!root) {
                if(DEBUG_MODE) Serial.println("[N0] ERROR CRÍTICO: No se pudo abrir el directorio raíz de la SD.");
                pixels.setPixelColor(0, pixels.Color(255, 0, 0)); pixels.show();
                vTaskDelay(pdMS_TO_TICKS(5000));
                continue;
            }

            File file_to_process;
            // (Modo Ráfaga) Este bucle while procesará TODOS los archivos que encuentre
            while(file_to_process = root.openNextFile()){
                String filename = file_to_process.name();
                if (filename.endsWith(".dat") && filename != "/buffer.dat") {
                    if(DEBUG_MODE) Serial.printf("\n[N0] ==> Archivo de batch encontrado: %s (Tamaño: %d bytes)\n", filename.c_str(), file_to_process.size());

                    // Chequeo de suscripción
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

                    // Procesar y enviar por MQTT línea por línea
                    bool batch_success = true;
                    String topic_mediciones = String(TOPIC_MEDICIONES) + deviceIdForMqtt;

                    while (file_to_process.available()) {
                        String line = file_to_process.readStringUntil('\n');
                        line.trim();
                        if (line.length() > 0) {
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
                                    if(DEBUG_MODE) Serial.println("[N0] ERROR: Fallo al publicar mensaje MQTT. Abortando este batch.");
                                    batch_success = false;
                                    break; // Rompe el bucle 'while (file_to_process.available())'
                                } else {
                                     if(DEBUG_MODE) Serial.print("."); // Imprime un punto por cada línea enviada
                                }
                            } else {
                                if(DEBUG_MODE) Serial.printf("[N0] ADVERTENCIA: Línea mal formada en %s, %d/10. Ignorada.\n", filename.c_str(), parsed_items);
                            }
                        }

                        // (Corrección de estabilidad) Evita WDT y timeouts de MQTT en archivos grandes
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
                     if(DEBUG_MODE && filename != "/" && !filename.endsWith(".dat")) Serial.printf("[N0-Debug] Archivo/Directorio ('%s') ignorado.\n", filename.c_str());
                }
                
                if (file_to_process) {
                    file_to_process.close();
                }
                esp_task_wdt_reset();
            } // Fin del bucle while (root.openNextFile())
            root.close();
            if(DEBUG_MODE) Serial.println("[N0-Debug] Búsqueda de archivos finalizada para este ciclo.");

        } else if (client.connected() && !boot_time_reported) {
            // Este mensaje ahora es normal si el RTC no tiene batería Y NTP está fallando.
            if(DEBUG_MODE) Serial.println("[N0-Debug] Esperando hora válida (RTC o NTP) para enviar reporte de arranque.");
        }
        
        // --- 8. REINICIO DIARIO PROGRAMADO (APROXIMADO) ---
        if (millis() - last_reboot_check_time > DAILY_RESTART_INTERVAL_MS) {
        
        // (Lógica de reinicio seguro)
        bool safeToReboot = !client.connected(); 
        if (client.connected()) {
            File rootCheck = SD.open("/");
            bool filesPending = false;
            if (rootCheck) {
                File checkFile = rootCheck.openNextFile();
                while(checkFile){
                    String fname = checkFile.name();
                    if (fname.endsWith(".dat") && fname != "/buffer.dat") {
                        filesPending = true;
                        checkFile.close();
                        break;
                    }
                    checkFile.close();
                    checkFile = rootCheck.openNextFile();
                }
                rootCheck.close();
            }
            if (!filesPending) {
                safeToReboot = true;
            }
        }

        if (safeToReboot) {
            if (DEBUG_MODE) Serial.println("[N0] Ejecutando reinicio diario programado...");
            delay(1000); 
            ESP.restart();
        } else {
             if (DEBUG_MODE) Serial.println("[N0] Reinicio diario pospuesto: Operación MQTT o archivos pendientes.");
             last_reboot_check_time = millis() - DAILY_RESTART_INTERVAL_MS + 10000; 
        }
    } else {
         last_reboot_check_time = millis();
    }


        // --- 9. FIN DE CICLO ---
        if(DEBUG_MODE) Serial.printf("[N0] <<< Fin del bucle. Esperando %lu ms.\n", MESSENGER_CYCLE_DELAY_MS);
        vTaskDelay(pdMS_TO_TICKS(MESSENGER_CYCLE_DELAY_MS));
    }
}

// =========================================================================
// === SETUP (ARQUITECTURA v14.0 - NO BLOQUEANTE)
// =========================================================================
void setup() {
    Serial.begin(115200);
    delay(1000); // Dar tiempo a que el monitor serial se conecte
    Serial.println("\n\n==================================================");
    Serial.println("== INICIANDO FIRMWARE CUENTATRÓN v14.0 ==");
    Serial.println("==================================================");

    // --- 1. INICIALIZAR HARDWARE BÁSICO ---
    Serial.print("Inicializando hardware básico (Pines, Neopixel)...");
    pinMode(BUTTON_PIN, INPUT_PULLUP); 
    pixels.begin();
    pixels.setBrightness(30);
    pixels.show();
    Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
    Serial.println(" OK.");

    // ✅ AGREGAR ESTO AQUÍ (ANTES DE TODO):
    // --- 1.5 INICIALIZAR STACK DE WIFI ---
    Serial.print("Inicializando stack de WiFi...");
    WiFi.mode(WIFI_STA); // Modo Station (cliente) // <-- LA LÍNEA CLAVE
    Serial.println(" OK.");

    // --- 2. INICIALIZAR RTC ---
    Serial.print("Inicializando RTC (DS3231)...");
    if (!rtc.begin()) {
        Serial.println("\nERROR CRÍTICO: No se encontró el módulo RTC. El sistema se detendrá.");
        drawBootScreen("ERROR: RTC");
        while (1) delay(1000);
    }
    // Si la batería del RTC falló, poner una hora por defecto
    if (rtc.lostPower()) {
        Serial.println("ADVERTENCIA: RTC perdió energía, la hora puede ser incorrecta hasta la sincronización NTP.");
        rtc.adjust(DateTime(2025, 1, 1, 0, 0, 0)); 
    }
    Serial.println(" OK.");

    // --- 3. INICIALIZAR PANTALLA ---
    Serial.print("Inicializando periféricos I2C (OLED)...");
    setupOLED();
    Serial.println(" OK.");
    drawBootScreen("Iniciando...");
    delay(500);

    // --- 4. INICIALIZAR TARJETA SD ---
    Serial.print("Montando tarjeta SD...");
    drawBootScreen("Montando SD...");
    if (!SD.begin(SD_CS_PIN)) {
        Serial.println("\nERROR CRÍTICO: Fallo al montar la tarjeta SD. El sistema se detendrá.");
        pixels.setPixelColor(0, pixels.Color(255, 0, 0)); pixels.show();
        drawBootScreen("ERROR: SD");
        while (1) delay(1000);
    }
    Serial.println(" OK.");    

    // --- 5. INICIALIZAR SISTEMA (MUTEX Y WATCHDOG) ---
    Serial.print("Configurando sistema multitarea (Mutex y Watchdog)...");
    sharedVarsMutex = xSemaphoreCreateMutex();
    // --- VERIFICACIÓN AÑADIDA ---
    if (sharedVarsMutex == NULL) {
        Serial.println("\nERROR CRÍTICO: Fallo al crear el Mutex. Memoria insuficiente.");
        Serial.println("El sistema se detendrá.");
        drawBootScreen("ERROR: MUTEX");
        while(1) delay(1000); // Detener el arranque
    }
    // --- FIN DE LA VERIFICACIÓN ---
    esp_task_wdt_config_t wdt_config = {
        .timeout_ms = WDT_TIMEOUT_SECONDS * 1000,
        .idle_core_mask = (1 << portNUM_PROCESSORS) - 1,
        .trigger_panic = true,
       };
    esp_task_wdt_reconfigure(&wdt_config);
    Serial.println(" OK.");

    // --- 6. CARGAR CONFIGURACIÓN Y APLICAR A EMONLIB ---
    drawBootScreen("Cargando config...");
    Serial.println("\n--- GESTIÓN DE CONFIGURACIÓN ---");
    
    // Cargar la última configuración válida guardada en la SD
    Serial.print("Cargando calibración desde la SD...");
    loadCalibration(); 
    Serial.println(" OK.");
    if(DEBUG_MODE) Serial.printf("   Valores cargados de SD -> V_CAL: %.2f, P_CAL: %.2f\n", voltage_cal, phase_cal);

    // Aplicar la calibración (cargada de la SD) a EmonLib
    Serial.print("Aplicando calibración a EmonLib...");
    applyCalibration();
    Serial.println(" OK.");
    Serial.println("--------------------------------");

    // --- 7. CONFIGURAR OTA (SOBRE ARDUINO) ---
    Serial.print("Configurando OTA...");
    drawBootScreen("Iniciando OTA...");
    
    ArduinoOTA.setHostname("Cuentatron"); // Puedes cambiar "lete-monitor" por "cuentatron-XXXX"
    ArduinoOTA.setPassword(OTA_PASSWORD);
    // --- AÑADIR ESTA LÍNEA ---
    Serial.printf("\n[DEBUG] Heap libre ANTES de ArduinoOTA.begin(): %d bytes\n", ESP.getFreeHeap());
    ArduinoOTA.begin();
    Serial.println(" OK.");

    // --- 8. INICIAR TAREAS DE LOS NÚCLEOS ---
    Serial.print("Iniciando tareas en los núcleos 0 y 1...");
    drawBootScreen("Iniciando tareas...");
    xTaskCreatePinnedToCore(writerTask, "WriterTask", 8192, NULL, 2, &writerTaskHandle, 1);
    xTaskCreatePinnedToCore(messengerTask, "MessengerTask", 16384, NULL, 1, &messengerTaskHandle, 0);
    Serial.println(" OK.");
    
    drawBootScreen("¡Listo!");
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
// --- FUNCIÓN PARA CONTACTAR A SUPABASE Y OBTENER TAREAS
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
    // Nota: 'setInsecure()' es necesario para Supabase en ESP32,
    // pero deshabilita la validación del certificado.
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
        } else {
            
            // --- 1. PROCESAR ESTADO DE SUSCRIPCIÓN ---
            if (doc.containsKey("subscription") && !doc["subscription"].isNull()) {
                if(DEBUG_MODE) Serial.println("[N0] Procesando objeto de suscripción...");
                
                JsonObject sub = doc["subscription"];
                String status_str = sub["status"].as<String>();
                String next_pay_str = sub["next_payment_date"].as<String>();
                int grace_days_val = sub["grace_days"] | 0; // 0 por defecto
                long next_pay_ts_val = sub["next_payment_ts"] | 0; // 0 por defecto

                // Actualizar las variables globales de forma segura (con Mutex)
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
                    }
                }
            } else {
                if(DEBUG_MODE) Serial.println("[N0] ADVERTENCIA: No se encontró el objeto 'subscription' en la respuesta.");
            }

            // --- 2. PROCESAR LA URL DEL SERVIDOR MQTT ---
            if (doc.containsKey("server_url") && !doc["server_url"].isNull()) {
                currentServerUrl = doc["server_url"].as<String>();
                if (DEBUG_MODE) Serial.printf("[N0] URL del servidor MQTT actualizada a: %s\n", currentServerUrl.c_str());
            }

            // --- 3. PROCESAR ACTUALIZACIÓN DE CALIBRACIÓN ("HOT RELOAD") ---
            JsonObject calibration = doc["calibration"];
            if (calibration.containsKey("update_available") && calibration["update_available"] == true) {

                // ¡CORRECCIÓN! Tomar el Mutex antes de tocar las variables de calibración
                if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
                    if (DEBUG_MODE) Serial.println("[N0] Tarea 'actualizar calibración' recibida. Mutex tomado.");

                    JsonObject values = calibration["values"];
                    voltage_cal = values["voltage"];
                    current_cal_phase = values["current1"];
                    current_cal_neutral = values["current2"];
                    if (values.containsKey("phase_cal")) {
                        phase_cal = values["phase_cal"];
                    }

                    // 1. Aplicar "en caliente" DENTRO del mutex
                    applyCalibration(); 

                    // 2. Marcar para guardar
                    newConfigFetched = true; 

                    xSemaphoreGive(sharedVarsMutex);
                    if (DEBUG_MODE) Serial.println("[N0] ¡ÉXITO! Calibración actualizada y Mutex liberado.");
                } else {
                    if (DEBUG_MODE) Serial.println("[N0] ERROR: No se pudo tomar el Mutex para aplicar calibración. Se reintentará en el próximo ciclo.");
                }
            }


            // --- 4. PROCESAR COMANDOS ---
            if (doc.containsKey("command") && !doc["command"].isNull()) {
                String cmd = doc["command"];
                if (DEBUG_MODE) Serial.printf("[N0] Tarea de 'comando' recibida: '%s'\n", cmd.c_str());

                if (cmd == "reboot") {
                    if (DEBUG_MODE) Serial.println("[N0] Ejecutando comando REBOOT en 3 segundos...");
                    delay(3000);
                    ESP.restart();
                } else if (cmd == "factory_reset") {
                    if (DEBUG_MODE) Serial.println("[N0] Comando remoto 'factory_reset' recibido. Ejecutando...");
                    handleFactoryReset(); // Llama a la función de reseteo
                }
            }
        }
    } else {
        if (DEBUG_MODE) Serial.printf("[N0] ERROR: Fallo al obtener tareas (HTTP: %d). Respuesta: %s\n", httpCode, http.getString().c_str());
    }
    
    http.end();
    return newConfigFetched;
}