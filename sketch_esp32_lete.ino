// ==========================================================================
// == FIRMWARE LETE - MONITOR DE ENERGÍA v7.0
// ==
// == MEJORAS DE LA VERSIÓN 7.0:
// == - ARQUITECTURA DE DOS NÚCLEOS: Un núcleo para mediciones y UI (tiempo real)
// ==   y otro para comunicaciones de red, eliminando bloqueos y mejorando estabilidad.
// == - FEEDBACK VISUAL MEJORADO: Mensaje en pantalla al presionar botón de configuración.
// == - PANTALLA DE SERVICIO MEJORADA: Muestra fecha de próximo pago y días de gracia restantes.
// == - ARRANQUE DE DISPLAY LIMPIO: Corregido el error de "estática" en la pantalla al encender.
// == - SINCRONIZACIÓN NTP ROBUSTA: Si la hora falla al arrancar, se reintenta periódicamente.
// == - CORRECCIÓN DE BUG EN BUFFER: Solucionado el error que impedía usar el buffer más allá del 9no archivo.
// == - ACCIONES REMOTAS: Implementada la capacidad de reiniciar o resetear el dispositivo desde Supabase.
// =========================================================================

// --- 1. LIBRERÍAS ---
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include <DNSServer.h>
#include <WiFiManager.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include "FS.h"
#include "SPIFFS.h"
#include <ArduinoJson.h>
#include "EmonLib.h"
#include "time.h"
#include "secrets.h" 
#include <esp_task_wdt.h>

// --- 2. CONFIGURACIÓN PRINCIPAL ---
const float FIRMWARE_VERSION = 7.0; // --> ACTUALIZADO v7.0
#define SERVICE_TYPE "1F"
const bool OLED_CONECTADA = true;
const bool DEBUG_MODE = true;

// Intervalos de tiempo
const unsigned long MEASUREMENT_INTERVAL_MS = 2000;
const unsigned long ACTIVE_SUB_CHECK_INTERVAL_MS = 12 * 3600 * 1000UL;
const unsigned long INACTIVE_SUB_CHECK_INTERVAL_MS = 5 * 60 * 1000UL;
const unsigned long UPDATE_CHECK_INTERVAL_MS = 4 * 3600 * 1000UL;
const unsigned long SCREEN_CONSUMPTION_INTERVAL_MS = 30000;
const unsigned long SCREEN_OTHER_INTERVAL_MS = 15000;
const unsigned long DAILY_RESTART_INTERVAL_MS = 24 * 3600 * 1000UL;
const unsigned long WIFI_CHECK_INTERVAL_MS = 30000;
const unsigned long NTP_RETRY_INTERVAL_MS = 15 * 60 * 1000; // --> AÑADIDO v7.0: Reintento de NTP cada 15 min
const unsigned long SERVER_TASKS_INTERVAL_MS = 4 * 3600 * 1000UL; // --> AÑADIDO v7.0: Chequeos al servidor cada 4h

// Configuración del Watchdog y Pulsación Larga
#define WDT_TIMEOUT_SECONDS 180
#define LONG_PRESS_DURATION_MS 10000 // 10 segundos

// Configuración del buffer en cola
#define MAX_BUFFER_FILE_SIZE 8192 // 8 KB por archivo
#define MAX_BUFFER_FILES 50       // Máximo de 50 archivos (50 * 8KB = 400 KB)

// --- 3. CONFIGURACIÓN DE PINES ---
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define I2C_SDA 21
#define I2C_SCL 22
#define BUTTON_PIN 0
const int VOLTAGE_SENSOR_PIN = 34;
const int CURRENT_SENSOR_PIN_1 = 35;
const int CURRENT_SENSOR_PIN_2 = 32;

// --- 4. OBJETOS Y VARIABLES GLOBALES ---
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
WebServer server(80);
EnergyMonitor emon1, emon2;

// --> AÑADIDO v7.0: Estructura y Cola para comunicación entre núcleos
struct MeasurementData {
    float vrms;
    float irms1;
    float irms2;
    float power;
    float leakage;
};
QueueHandle_t dataQueue;

// Variables de Calibración
float voltage_cal = 265.0;
float current_cal_1 = 11.07;
float current_cal_2 = 11.07;

// Variables de Estado
float latest_vrms = 0.0;
float latest_irms1 = 0.0;
float latest_irms2 = 0.0;
float latest_power = 0.0;
float latest_leakage = 0.0;
float latest_temp_cpu = 0.0; 
bool server_status = false;
bool time_synced = false;
bool subscription_active = false;
bool pago_vencido = false;
int dias_de_gracia_restantes = 0;
String proximo_pago_str = "--/--/----"; // --> AÑADIDO v7.0
int buffer_file_count = 0;

// Variables de Control
unsigned long last_measurement_time = 0;
unsigned long last_server_tasks_check = 0; // --> ACTUALIZADO v7.0: Un solo timer para tareas de servidor
unsigned long last_button_press = 0;
unsigned long last_screen_change_time = 0;
unsigned long last_wifi_check = 0;
unsigned long button_press_start_time = 0;
bool button_is_pressed = false;
int screen_mode = 0;
int lecturas_descartadas = 0;
const int LECTURAS_A_DESCARTAR = 10;

// --- 5. DECLARACIONES DE FUNCIONES (PROTOTIPOS) ---
// --> ACTUALIZADO v7.0: Lista completa y organizada de prototipos

// Tarea del Núcleo 0
void networkTask(void * pvParameters);

// Lógica Principal y de Medición
void saveCalibration();
void loadCalibration();
int countBufferFiles();
void writeToBuffer(const char* data_payload);
void processBufferQueue();
void sendDataToInflux(MeasurementData data);
void measureAndStoreData();

// Tareas de Servidor (llamadas por networkTask)
void checkServerTasks();
void checkSubscriptionStatus();
void checkForHttpUpdate();

// Funciones de Servidor Web (Web Handlers)
void handleRoot();
void handleUpdate();
void handleResetWifi();
void handleCalibration();
void handleRestart();
void handleFactoryReset();

// Funciones de Pantalla OLED
void setupOLED();
void drawConsumptionScreen();
void drawDiagnosticsScreen();
void drawServiceScreen();
void drawBootScreen();
void drawConfigScreen(const char* apName);
void drawUpdateScreen(String text);
void drawGenericMessage(String line1, String line2);
void drawPaymentDueScreen();
const char* getWifiIcon(int rssi);

// --- FUNCIONES DE LÓGICA PRINCIPAL ---

// --- MEJORA v7.0: Tarea dedicada para el Núcleo 0 (Comunicaciones) ---
void networkTask(void * pvParameters) {
    if (DEBUG_MODE) Serial.println("Tarea de Red iniciada en Núcleo 0.");
    
    // Temporizadores para tareas dentro del Núcleo 0
    unsigned long last_ntp_sync_attempt = 0;

    for (;;) { // Bucle infinito para la tarea de red
        if (WiFi.status() == WL_CONNECTED) {
            
            // --- Lógica de Sincronización NTP Periódica ---
            if (!time_synced && millis() - last_ntp_sync_attempt > NTP_RETRY_INTERVAL_MS) {
                last_ntp_sync_attempt = millis();
                if (DEBUG_MODE) Serial.println("[N0] Reintentando sincronizacion de hora NTP...");
                configTime(0, 0, NTP_SERVER);
                
                struct tm timeinfo;
                if (getLocalTime(&timeinfo)) {
                    time_synced = true;
                    if (DEBUG_MODE) Serial.println("[N0] Hora NTP sincronizada exitosamente.");
                } else {
                    if (DEBUG_MODE) Serial.println("[N0] Fallo al reintentar la sincronizacion NTP.");
                }
            }

            // --- Lógica de Procesamiento de Datos ---
            // 1. Prioridad: procesar datos en tiempo real que lleguen por la cola
            MeasurementData receivedData;
            if (xQueueReceive(dataQueue, &receivedData, 0) == pdTRUE) {
                sendDataToInflux(receivedData);
            }

            // 2. Si no hay datos en vivo, intentar vaciar el buffer de archivos
            else if (countBufferFiles() > 0) {
                processBufferQueue();
            }

            // --- Lógica de Tareas de Servidor (cada 4 horas) ---
            if (millis() - last_server_tasks_check > SERVER_TASKS_INTERVAL_MS) {
                last_server_tasks_check = millis();
                checkServerTasks(); // Esta función agrupa todas las llamadas a Supabase
            }
        }
        
        // Pausa corta para que la tarea sea muy responsiva
        vTaskDelay(pdMS_TO_TICKS(1000)); // Revisar la cola cada segundo
    }
}

// --> Guarda los valores de calibración en la memoria permanente (SPIFFS)
void saveCalibration() {
    File file = SPIFFS.open("/calibracion.tmp", FILE_WRITE);
    if (!file) {
        if (DEBUG_MODE) Serial.println("Error al abrir archivo temporal de calibracion");
        return;
    }
    StaticJsonDocument<256> doc;
    doc["voltage_cal"] = voltage_cal;
    doc["current_cal_1"] = current_cal_1;
    doc["current_cal_2"] = current_cal_2;

    if (serializeJson(doc, file) == 0) {
        if (DEBUG_MODE) Serial.println("Error al escribir en archivo temporal de calibracion");
    } else {
        if (DEBUG_MODE) Serial.println("Calibracion guardada en archivo temporal.");
        file.close();
        // Si la escritura fue exitosa, reemplazar el archivo original
        SPIFFS.remove("/calibracion.json");
        SPIFFS.rename("/calibracion.tmp", "/calibracion.json");
        if (DEBUG_MODE) Serial.println("Archivo de calibracion actualizado.");
    }
    if(file) file.close();
}

// --> Carga los valores de calibración desde SPIFFS al arrancar
void loadCalibration() {
    if (SPIFFS.exists("/calibracion.json")) {
        File file = SPIFFS.open("/calibracion.json", FILE_READ);
        if (!file) {
            if (DEBUG_MODE) Serial.println("No se pudo abrir el archivo de calibracion");
            return;
        }
        StaticJsonDocument<256> doc;
        DeserializationError error = deserializeJson(doc, file);
        if (error) {
            if (DEBUG_MODE) Serial.printf("Error al leer archivo de calibracion: %s\n", error.c_str());
            file.close();
            return;
        }
        
        // Asignación segura, solo si la clave existe en el JSON
        if (doc.containsKey("voltage_cal")) voltage_cal = doc["voltage_cal"];
        if (doc.containsKey("current_cal_1")) current_cal_1 = doc["current_cal_1"];
        if (doc.containsKey("current_cal_2")) current_cal_2 = doc["current_cal_2"];
        
        if (DEBUG_MODE) Serial.println("Calibracion cargada desde SPIFFS.");
        file.close();
    } else {
        if (DEBUG_MODE) Serial.println("No se encontro archivo de calibracion, guardando valores por defecto.");
        saveCalibration();
    }
}

// --> MEJORA v6.0: Cuenta cuántos archivos de buffer existen
int countBufferFiles() {
    int count = 0;
    for (int i = 0; i < MAX_BUFFER_FILES; i++) {
        String filename = "/buffer_" + String(i) + ".txt";
        if (SPIFFS.exists(filename)) {
            count++;
        }
    }
    return count;
}

// --> MEJORA v6.0: Lógica para escribir datos en la cola del buffer
void writeToBuffer(const char* data_payload) {
    String filename;
    bool file_found = false;
    for (int i = 0; i < MAX_BUFFER_FILES; i++) {
        filename = "/buffer_" + String(i) + ".txt";
        if (!SPIFFS.exists(filename)) {
            file_found = true;
            break;
        }
        File file = SPIFFS.open(filename, FILE_READ);
        if (file && file.size() < MAX_BUFFER_FILE_SIZE) {
            file.close();
            file_found = true;
            break;
        }
        if(file) file.close();
    }

    if (!file_found) {
        if (DEBUG_MODE) Serial.println("[N0] Buffer lleno, no se pueden crear más archivos. Dato descartado.");
        return;
    }

    File bufferFile = SPIFFS.open(filename, FILE_APPEND);
    if (bufferFile) {
        bufferFile.print(data_payload);
        bufferFile.close();
        if (DEBUG_MODE) Serial.printf("[N0] Dato guardado en buffer: %s\n", filename.c_str());
    }
}

// Nueva función que envía un struct de datos a InfluxDB
void sendDataToInflux(MeasurementData data) {
    // --> MEJORA v7.0: Doble chequeo de seguridad al inicio de la función
    if (WiFi.status() != WL_CONNECTED || !subscription_active) {
        char data_payload[256]; // Prepara el payload incluso si falla
        sprintf(data_payload, "%s,device=LETE-%04X vrms=%.2f,irms1=%.3f,irms2=%.3f,power=%.2f,leakage=%.3f\n",
                INFLUXDB_MEASUREMENT, (uint16_t)ESP.getEfuseMac(),
                data.vrms, data.irms1, data.irms2, data.power, data.leakage);
        if (DEBUG_MODE) Serial.println("[N0] Envío omitido (sin WiFi/suscripción). Guardando en buffer.");
        writeToBuffer(data_payload);
        return; 
    }
    
    char data_payload[256];
    sprintf(data_payload, "%s,device=LETE-%04X vrms=%.2f,irms1=%.3f,irms2=%.3f,power=%.2f,leakage=%.3f\n",
            INFLUXDB_MEASUREMENT, (uint16_t)ESP.getEfuseMac(),
            data.vrms, data.irms1, data.irms2, data.power, data.leakage);

    HTTPClient http;
    http.setTimeout(2000);
    http.begin(INFLUXDB_URL);
    http.addHeader("Authorization", "Token " INFLUXDB_TOKEN);
    http.addHeader("Content-Type", "text/plain");
    
    int httpCode = http.POST(data_payload);
    server_status = (httpCode >= 200 && httpCode < 300);

    if (server_status) {
        if (DEBUG_MODE) Serial.println("[N0] Dato en vivo enviado a InfluxDB correctamente.");
    } else {
        if (DEBUG_MODE) Serial.printf("[N0] Error al enviar dato en vivo. Codigo HTTP: %d. Guardando en buffer.\n", httpCode);
        writeToBuffer(data_payload);
    }
    http.end();
}

// --> MEJORA v6.0: Lógica para procesar y enviar datos desde la cola del buffer
void processBufferQueue() {
    if (WiFi.status() != WL_CONNECTED || !subscription_active) {
        return; // No intentar enviar si no hay conexión o suscripción
    }

    String filename;
    File bufferFile;
    bool file_found = false;
    for (int i = 0; i < MAX_BUFFER_FILES; i++) {
        filename = "/buffer_" + String(i) + ".txt";
        if (SPIFFS.exists(filename)) {
            bufferFile = SPIFFS.open(filename, FILE_READ);
            if (bufferFile && bufferFile.size() > 0) {
                file_found = true;
                break;
            }
            if(bufferFile) bufferFile.close();
        }
    }
    if (!file_found) return;

    String payload_to_send = bufferFile.readString();
    bufferFile.close();

    HTTPClient http;
    http.setTimeout(4000); // Damos un poco más de tiempo para archivos más grandes
    http.begin(INFLUXDB_URL);
    http.addHeader("Authorization", "Token " INFLUXDB_TOKEN);
    http.addHeader("Content-Type", "text/plain");
    
    int httpCode = http.POST(payload_to_send);
    server_status = (httpCode >= 200 && httpCode < 300);

    if (server_status) {
        if (DEBUG_MODE) Serial.printf("[N0] Buffer %s enviado. Eliminando archivo.\n", filename.c_str());
        SPIFFS.remove(filename);
    } else {
        if (DEBUG_MODE) Serial.printf("[N0] Error al enviar buffer %s. Codigo HTTP: %d.\n", filename.c_str(), httpCode);
    }
    http.end();
}

// --> MEJORA v7.0: Función ÚNICA que agrupa todas las tareas pesadas del servidor.
void checkServerTasks() {
    if (WiFi.status() != WL_CONNECTED) return;
    if (DEBUG_MODE) Serial.println("\n[N0] Ejecutando tareas periódicas de servidor...");

    String deviceId = WiFi.macAddress();
    deviceId.replace(":", "");
    String urlConId = String(SERVER_TASKS_URL) + "?deviceId=" + deviceId;

    HTTPClient http;
    http.setTimeout(4000);
    http.begin(urlConId);
    http.addHeader("Authorization", "Bearer " + String(SUPABASE_ANON_KEY));
    int httpCode = http.GET();

    if (httpCode == HTTP_CODE_OK) {
        String payload = http.getString();
        StaticJsonDocument<512> doc;
        deserializeJson(doc, payload);

        // --- Tarea 1: Procesar Suscripción ---
        if (doc.containsKey("subscription_payload")) {
            String sub_payload = doc["subscription_payload"];
            int first_pipe = sub_payload.indexOf('|');
            int second_pipe = sub_payload.indexOf('|', first_pipe + 1);
            if (first_pipe > 0 && second_pipe > first_pipe) {
                subscription_active = (sub_payload.substring(0, first_pipe) == "active");
                dias_de_gracia_restantes = sub_payload.substring(first_pipe + 1, second_pipe).toInt();
                proximo_pago_str = sub_payload.substring(second_pipe + 1);
                pago_vencido = !subscription_active;
                if(DEBUG_MODE) Serial.println("[N0] Datos de suscripción actualizados.");
            }
        }

        // --- Tarea 2: Procesar Calibración Remota ---
        if (doc["calibration"]["update_available"] == true) {
            if (DEBUG_MODE) Serial.println("[N0] ¡Nuevos datos de calibracion recibidos!");
            voltage_cal = doc["calibration"]["values"]["voltage"];
            current_cal_1 = doc["calibration"]["values"]["current1"];
            current_cal_2 = doc["calibration"]["values"]["current2"];
            saveCalibration();
        }

        // --- Tarea 3: Procesar Comandos Remotos ---
        if (doc.containsKey("command") && doc["command"] != nullptr) {
            String command = doc["command"];
            if (command == "reboot") {
                if (DEBUG_MODE) Serial.println("[N0] Comando 'reboot' recibido. Reiniciando en 3s...");
                delay(3000);
                ESP.restart();
            } else if (command == "factory_reset") {
                if (DEBUG_MODE) Serial.println("[N0] Comando 'factory_reset' recibido. Ejecutando...");
                handleFactoryReset();
            }
        }
    } else {
        if (DEBUG_MODE) Serial.printf("[N0] Error al chequear tareas del servidor. Codigo HTTP: %d\n", httpCode);
    }
    http.end();
    
    // El chequeo de actualización de firmware (OTA) lo dejamos separado porque no depende de Supabase
    checkForHttpUpdate();
}

// Busca actualizaciones de firmware remotas vía HTTP
void checkForHttpUpdate() {
    if (WiFi.status() != WL_CONNECTED) return;
    if (DEBUG_MODE) Serial.println("[N0] Buscando actualizaciones de firmware...");
    
    // En el futuro, considera mostrar un ícono en la pantalla OLED
    // if (OLED_CONECTADA) drawUpdateScreen("Buscando...");

    HTTPClient http;
    http.setTimeout(2000); // --> MEJORA v7.0: Añadido timeout
    http.begin(FIRMWARE_VERSION_URL);
    int httpCode = http.GET();

    if (httpCode == HTTP_CODE_OK) {
        String version_str = http.getString();
        version_str.trim();
        float new_version = version_str.toFloat();
        if (DEBUG_MODE) Serial.printf("[N0] Version actual: %.1f, Version en servidor: %.1f\n", FIRMWARE_VERSION, new_version);

        if (new_version > FIRMWARE_VERSION) {
            if (DEBUG_MODE) Serial.println("[N0] Nueva version disponible. Actualizando...");
            if (OLED_CONECTADA) drawUpdateScreen("Descargando");

            HTTPClient httpUpdateClient;
            httpUpdateClient.begin(FIRMWARE_BIN_URL);
            t_httpUpdate_return ret = httpUpdate.update(httpUpdateClient);

            if (ret == HTTP_UPDATE_FAILED) {
                if (DEBUG_MODE) Serial.printf("[N0] Actualizacion Fallida. Error (%d): %s\n", httpUpdate.getLastError(), httpUpdate.getLastErrorString().c_str());
                if (OLED_CONECTADA) drawUpdateScreen("Error!");
                delay(2000);
            }
        } else {
            if (DEBUG_MODE) Serial.println("[N0] El firmware ya esta actualizado.");
        }
    } else {
        if (DEBUG_MODE) Serial.printf("[N0] Error al verificar version. Codigo HTTP: %d\n", httpCode);
    }
    http.end();
}

// Mide los sensores y pone los datos en la cola para el Núcleo 0
void measureAndStoreData() {
    // Esta función está perfecta, no necesita cambios.
    emon1.calcVI(20, 2000);
    emon1.calcIrms(1480);
    emon2.calcIrms(1480);

    latest_vrms = emon1.Vrms;
    latest_power = emon1.realPower;
    latest_irms1 = emon1.Irms;
    latest_irms2 = emon2.Irms;
    latest_temp_cpu = temperatureRead();

    if (isnan(latest_vrms) || isinf(latest_vrms) || isnan(latest_irms1) || isinf(latest_irms1)) {
        if (DEBUG_MODE) Serial.println("[N1] Lectura inválida (NaN/Inf) descartada.");
        return;
    }

    if (latest_vrms < 30.0) latest_vrms = 0.0;
    if (latest_irms1 < 0.05) latest_irms1 = 0.0;
    if (latest_irms2 < 0.05) latest_irms2 = 0.0;
    if (latest_vrms == 0.0 || latest_irms1 == 0.0) latest_power = 0.0;
    latest_leakage = abs(latest_irms1 - latest_irms2);

    MeasurementData dataToSend;
    dataToSend.vrms = latest_vrms;
    dataToSend.irms1 = latest_irms1;
    dataToSend.irms2 = latest_irms2;
    dataToSend.power = latest_power;
    dataToSend.leakage = latest_leakage;

    if (xQueueSend(dataQueue, &dataToSend, pdMS_TO_TICKS(100)) != pdTRUE) {
        if (DEBUG_MODE) Serial.println("[N1] La cola de datos está llena, medida descartada.");
    }
}

// --- FUNCIONES DE INTERFAZ WEB (SERVIDOR) ---

// --> Página principal de la interfaz web
void handleRoot() {
    if (!server.authenticate(HTTP_USER, HTTP_PASS)) {
        return server.requestAuthentication();
    }
    char uptime_str[20];
    long uptime_seconds = millis() / 1000;
    sprintf(uptime_str, "%dd %dh %dm", uptime_seconds / 86400, (uptime_seconds % 86400) / 3600, (uptime_seconds % 3600) / 60);

    String html = "<html><head><title>Monitor LETE</title>";
    html += "<meta http-equiv='refresh' content='5'>";
    html += "<meta name='viewport' content='width=device-width, initial-scale=1'>";
    html += "<style>body{font-family:sans-serif;} h2{color:#005b96;}</style></head><body>"; // Pequeño ajuste de estilo
    html += "<h1>Monitor LETE v" + String(FIRMWARE_VERSION, 1) + "</h1>";
    
    html += "<h2>Estado Principal</h2>";
    html += "<p><b>Voltaje:</b> " + String(latest_vrms, 1) + " V</p>";
    html += "<p><b>Corriente:</b> " + String(latest_irms1, 2) + " A</p>";
    html += "<p><b>Potencia:</b> " + String(latest_power, 0) + " W</p>";
    html += "<p><b>Fuga:</b> " + String(latest_leakage, 3) + " A</p>";

    html += "<h2>Conectividad</h2>";
    html += "<p><b>Red:</b> " + WiFi.SSID() + " (" + String(WiFi.RSSI()) + " dBm)</p>";
    html += "<p><b>IP:</b> " + WiFi.localIP().toString() + "</p>";
    html += "<p><b>Nube:</b> " + String(server_status ? "OK" : "Error") + "</p>";
    html += "<p><b>Suscripci&oacute;n:</b> " + String(subscription_active ? "Activa" : "Inactiva") + "</p>";

    html += "<h2>Diagnostico del Sistema</h2>";
    html += "<p><b>Uptime:</b> " + String(uptime_str) + "</p>";
    html += "<p><b>Memoria Libre:</b> " + String(ESP.getFreeHeap() / 1024) + " KB</p>";

    html += "<p><b>Archivos en Buffer:</b> " + String(buffer_file_count) + "</p>";

    html += "<h2>Acciones</h2>";
    html += "<p><a href='/calibracion'>Ajustar Calibracion</a></p>";
    html += "<p><a href='/update'>Buscar Actualizaciones de Firmware</a></p>";
    html += "<p><a href='/reset-wifi'>Borrar Credenciales Wi-Fi</a></p>";
    html += "<p><a href='/restart' onclick='return confirm(\"¿Estás seguro de que quieres reiniciar el dispositivo?\");'>Reiniciar Dispositivo</a></p>";
    // --- LÍNEA AÑADIDA ---
    html += "<p style='color:red;'><a href='/factory-reset' onclick='return confirm(\"¡ACCIÓN DESTRUCTIVA!\\n¿Estás SEGURO de que quieres borrar TODOS los datos (WiFi, calibración) y reiniciar?\");'>Reseteo de Fábrica</a></p>";

    html += "</body></html>";

    server.send(200, "text/html", html);
}

// --> Inicia una búsqueda de actualizaciones de firmware
void handleUpdate() {
    if (!server.authenticate(HTTP_USER, HTTP_PASS)) return server.requestAuthentication();
    server.send(200, "text/plain", "OK. Buscando actualizaciones... Revisa el Monitor Serie.");
    delay(100);
    checkForHttpUpdate();
}

// --> Borra las credenciales de Wi-Fi y reinicia en modo configuración
void handleResetWifi() {
    if (!server.authenticate(HTTP_USER, HTTP_PASS)) return server.requestAuthentication();
    server.send(200, "text/plain", "OK. Credenciales Wi-Fi borradas. El dispositivo se reiniciar&aacute; en Modo Configuraci&oacute;n.");
    delay(1000);
    WiFiManager wm;
    wm.resetSettings();
    ESP.restart();
}

// --> Página para ver y guardar los valores de calibración
void handleCalibration() {
    if (!server.authenticate(HTTP_USER, HTTP_PASS)) return server.requestAuthentication();
    if (server.method() == HTTP_POST) {
        voltage_cal = server.arg("voltage").toFloat();
        current_cal_1 = server.arg("current1").toFloat();
        current_cal_2 = server.arg("current2").toFloat();
        saveCalibration();
        server.send(200, "text/plain", "OK. Calibracion guardada.");
    } else {
        String html = "<html><head><title>Calibracion LETE</title></head><body>";
        html += "<h1>Calibracion del Dispositivo</h1>";
        html += "<form action='/calibracion' method='POST'>";
        html += "Voltaje (V_CAL): <input type='text' name='voltage' value='" + String(voltage_cal) + "'><br>";
        html += "Corriente 1 (I_CAL1): <input type='text' name='current1' value='" + String(current_cal_1) + "'><br>";
        html += "Corriente 2 (I_CAL2): <input type='text' name='current2' value='" + String(current_cal_2) + "'><br>";
        html += "<input type='submit' value='Guardar'>";
        html += "</form></body></html>";
        server.send(200, "text/html", html);
    }
}

// --> Reinicia el dispositivo
void handleRestart() {
    if (!server.authenticate(HTTP_USER, HTTP_PASS)) {
        return server.requestAuthentication();
    }
    server.send(200, "text/html", "<h1>Reiniciando el dispositivo...</h1><p>El dispositivo se reiniciará en 2 segundos. Cierra esta ventana.</p>");
    delay(2000); // Pequeña pausa para asegurar que el mensaje se envía
    ESP.restart();
}

// --> Borra todos los datos y reinicia (Wi-Fi y Calibración)
void handleFactoryReset() {
    if (!server.authenticate(HTTP_USER, HTTP_PASS)) {
        return server.requestAuthentication();
    }

    if (DEBUG_MODE) Serial.println("Iniciando reseteo de fábrica...");

    // Borrar credenciales de Wi-Fi
    WiFiManager wm;
    wm.resetSettings();
    if (DEBUG_MODE) Serial.println("Credenciales Wi-Fi borradas.");

    // Borrar archivo de calibración
    if (SPIFFS.exists("/calibracion.json")) {
        SPIFFS.remove("/calibracion.json");
        if (DEBUG_MODE) Serial.println("Archivo de calibracion borrado.");
    }

    // --> MEJORA v6.0: Borrar todos los archivos del buffer en cola
    if (DEBUG_MODE) Serial.println("Borrando archivos de buffer...");
    for (int i = 0; i < MAX_BUFFER_FILES; i++) {
    String filename = "/buffer_" + String(i) + ".txt";
    if (SPIFFS.exists(filename)) {
        SPIFFS.remove(filename);
    }
 }

    server.send(200, "text/html", "<h1>Reseteo de Fábrica Completo</h1><p>El dispositivo se reiniciará en 2 segundos en modo de configuración.</p>");
    delay(2000);
    ESP.restart();
}

// --- FUNCIÓN DE SETUP (VERSIÓN FINAL Y PULIDA) ---
void setup() {
    Serial.begin(115200);
    pinMode(BUTTON_PIN, INPUT_PULLUP);

    // --- MODO DE RECUPERACIÓN ---
    if (digitalRead(BUTTON_PIN) == LOW) {
        setupOLED();
        if (DEBUG_MODE) Serial.println("Boton presionado al arranque. Forzando modo de configuracion...");
        drawGenericMessage("Modo Configuracion", "Forzado al arranque");
        
        WiFiManager wm;
        wm.setConfigPortalTimeout(300);

        // --> CORRECCIÓN: Usamos startConfigPortal para forzar el portal directamente
        if (!wm.startConfigPortal("LETE-Monitor-Config")) {
            if (DEBUG_MODE) Serial.println("Fallo al conectar desde el portal. Reiniciando.");
        } else {
            if (DEBUG_MODE) Serial.println("WiFi configurado exitosamente. Reiniciando.");
        }
        delay(2000);
        ESP.restart();
    }

    // --- ARRANQUE NORMAL ---
    // 1. Configuración del Watchdog Timer
    if (DEBUG_MODE) Serial.println("Configurando Watchdog Timer...");
    esp_task_wdt_config_t wdt_config = {
        .timeout_ms = WDT_TIMEOUT_SECONDS * 1000,
        .idle_core_mask = (1 << portNUM_PROCESSORS) - 1,
        .trigger_panic = true,
    };
    esp_task_wdt_reconfigure(&wdt_config);
    esp_task_wdt_add(NULL);

    // 2. Inicialización de periféricos
    setupOLED();
    if (!SPIFFS.begin(true)) {
        if (DEBUG_MODE) Serial.println("Error crítico al montar SPIFFS. Reiniciando en 5s...");
        delay(5000); ESP.restart();
    }
    if (DEBUG_MODE) Serial.println("SPIFFS montado.");

    // 3. Carga de configuración y mensaje
    loadCalibration();
    drawGenericMessage("Luz en tu Espacio", "Iniciando...");
    
    // 4. Inicialización de sensores
    emon1.voltage(VOLTAGE_SENSOR_PIN, voltage_cal, 1.7);
    emon1.current(CURRENT_SENSOR_PIN_1, current_cal_1);
    emon2.current(CURRENT_SENSOR_PIN_2, current_cal_2);

    // 5. Intento de conexión WiFi
    WiFi.mode(WIFI_STA);
    WiFi.begin();
    if (DEBUG_MODE) Serial.print("Conectando a WiFi...");
    byte Cnt = 0;
    while (WiFi.status() != WL_CONNECTED && Cnt < 30) {
        Cnt++;
        delay(500);
        Serial.print(".");
        esp_task_wdt_reset();
    }

    if (WiFi.status() == WL_CONNECTED) {
        if (DEBUG_MODE) {
            Serial.println("\nConectado a la red Wi-Fi!");
            Serial.print("Dirección IP: "); Serial.println(WiFi.localIP());
        }
    } else {
        if (DEBUG_MODE) Serial.println("\nNo se pudo conectar al WiFi guardado. Se reintentará en el loop.");
    }
    esp_task_wdt_reset();
    
    // 6. Sincronización de hora (NTP)
    configTime(0, 0, NTP_SERVER);
    struct tm timeinfo;
    int retry_count = 0;
    while (!getLocalTime(&timeinfo) && retry_count < 5) {
        if (DEBUG_MODE) Serial.printf("Fallo al obtener hora NTP. Reintentando... (%d/5)\n", retry_count + 1);
        retry_count++;
        delay(2000);
        esp_task_wdt_reset();
    }
    if (getLocalTime(&timeinfo)) {
        time_synced = true;
    } else {
        time_synced = false;
    }
    esp_task_wdt_reset();
    
    // 7. Inicialización de OTA y Servidor Web
    ArduinoOTA.setHostname("lete-monitor");
    ArduinoOTA.setPassword(OTA_PASSWORD);
    ArduinoOTA.begin();
    
    server.on("/", handleRoot);
    server.on("/update", handleUpdate);
    server.on("/reset-wifi", handleResetWifi);
    server.on("/calibracion", handleCalibration);
    server.on("/restart", handleRestart);
    server.on("/factory-reset", handleFactoryReset);
    server.begin();

    // 8. Chequeo inicial de tareas del servidor (suscripción, etc.)
 if (WiFi.status() == WL_CONNECTED) {
    if (DEBUG_MODE) Serial.println("Realizando chequeo inicial de tareas del servidor...");
    checkServerTasks();
}

    // 9. Chequeo inicial de actualización de firmware
    delay(100);
    checkForHttpUpdate();
    esp_task_wdt_reset();

    // 10. (ÚLTIMO PASO) Crear cola y lanzar la tarea del Núcleo 0
    dataQueue = xQueueCreate(10, sizeof(MeasurementData));
    if (dataQueue != NULL) {
        xTaskCreatePinnedToCore(
            networkTask, "Network Task", 10000, NULL, 1, NULL, 0);
    } else {
        if(DEBUG_MODE) Serial.println("Error critico: No se pudo crear la cola de datos.");
    }
}

// --- FUNCIÓN DE LOOP PRINCIPAL (VERSIÓN FINAL v7.0 PARA NÚCLEO 1) ---
void loop() {
    // 1. Tareas de Mantenimiento Esenciales
    esp_task_wdt_reset();
    unsigned long currentMillis = millis();

    // Las tareas de OTA y Web Server son rápidas y se atienden aquí
    ArduinoOTA.handle();
    server.handleClient();

    // 2. Lógica de Pulsación del Botón (Configuración y Cambio de Pantalla)
    if (digitalRead(BUTTON_PIN) == LOW) {
        if (!button_is_pressed) {
            // Se acaba de presionar, iniciar temporizadores
            button_press_start_time = currentMillis;
            last_button_press = currentMillis;
            button_is_pressed = true;
        } else {
            // El botón se mantiene presionado, verificar para feedback y acción
            if ((currentMillis - button_press_start_time > 5000) && (currentMillis - button_press_start_time < 5500)) {
                if (OLED_CONECTADA) drawGenericMessage("Siga presionando", "para configurar...");
            }
            if (currentMillis - button_press_start_time > LONG_PRESS_DURATION_MS) {
                if (OLED_CONECTADA) drawGenericMessage("Modo Configuracion", "Soltar boton...");
                
                WiFiManager wm;
                wm.setConfigPortalTimeout(180);
                if (wm.startConfigPortal("LETE-Monitor-Config")) {
                    if (OLED_CONECTADA) drawGenericMessage("Config OK", "Reiniciando...");
                } else {
                    if (OLED_CONECTADA) drawGenericMessage("Config Fallo", "Reiniciando...");
                }
                delay(2000);
                ESP.restart();
            }
        }
    } else {
        // El botón se soltó
        if (button_is_pressed) {
            // Si fue una pulsación corta, cambiar de pantalla
            if (currentMillis - last_button_press < 2000) { // Menos de 2 segundos
                screen_mode = (screen_mode + 1) % 3;
                last_screen_change_time = currentMillis;
            }
        }
        button_is_pressed = false;
    }

    // 3. Chequeo de reconexión WiFi
    if (currentMillis - last_wifi_check > WIFI_CHECK_INTERVAL_MS) {
        last_wifi_check = currentMillis;
        if (WiFi.status() != WL_CONNECTED) {
            if (DEBUG_MODE) Serial.println("[N1] Wi-Fi desconectado. Intentando reconectar...");
            WiFi.reconnect();
        }
    }

    // 4. Medición y envío de datos a la cola
    if (currentMillis - last_measurement_time > MEASUREMENT_INTERVAL_MS) {
        last_measurement_time = currentMillis;
        if (lecturas_descartadas < LECTURAS_A_DESCARTAR) {
            emon1.calcVI(20, 2000);
            lecturas_descartadas++;
        } else {
            measureAndStoreData();
        }
    }
    
    // 5. Lógica de Pantalla OLED
    buffer_file_count = countBufferFiles(); // Actualiza el contador
    if (OLED_CONECTADA) {
        unsigned long current_rotation_interval = (screen_mode == 0) ? SCREEN_CONSUMPTION_INTERVAL_MS : SCREEN_OTHER_INTERVAL_MS;
        
        if (currentMillis - last_screen_change_time > current_rotation_interval) {
            screen_mode = (screen_mode + 1) % 3;
            last_screen_change_time = currentMillis;
        }

        if (pago_vencido) {
            drawPaymentDueScreen();
        } else {
            switch (screen_mode) {
                case 0: drawConsumptionScreen(); break;
                case 1: drawDiagnosticsScreen(); break;
                case 2: drawServiceScreen(); break;
            }
        }
    }
    
    // 6. Reinicio diario programado
    if (currentMillis > DAILY_RESTART_INTERVAL_MS) {
        if (DEBUG_MODE) Serial.println("Reinicio diario programado. Reiniciando...");
        delay(1000);
        ESP.restart();
    }
}

// --- INCLUSIÓN DE ARCHIVOS SEPARADOS ---
#include "oled_screens.h"