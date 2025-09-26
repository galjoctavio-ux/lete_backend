// ==========================================================================
// == FIRMWARE LETE - MONITOR DE ENERGÍA v6.0
// ==
// == MEJORAS DE LA VERSIÓN:
// == - Versión del firmware actualizada a 6.0.
// == - Activación de modo configuración WiFi por pulsación larga (10s) en cualquier momento.
// == - Lógica de reintentos de suscripción adaptable (rápida si está inactiva, lenta si está activa).
// == - Guardado "atómico" de calibración en SPIFFS para prevenir corrupción de archivos.
// == - Carga robusta de calibración con validación de datos y mejores diagnósticos de error.
// == - Rediseño completo del sistema de buffer a una cola de archivos para bajo uso de RAM y envío seguro.
// == - Arquitectura base para futura calibración remota desde un servidor.
// == - Rediseño completo de las pantallas OLED a 3 modos más útiles: Consumo, Diagnóstico y Servicio.
// == - La pantalla de Consumo ahora tiene mayor duración en la rotación automática.
// == - Indicador visual del buffer de datos en la pantalla OLED.
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
const float FIRMWARE_VERSION = 6.0;
#define SERVICE_TYPE "1F"
const bool OLED_CONECTADA = true;
const bool DEBUG_MODE = true;

// Intervalos de tiempo
const unsigned long MEASUREMENT_INTERVAL_MS = 2000;
// --> MEJORA v6.0: Intervalos de chequeo de suscripción adaptables
const unsigned long ACTIVE_SUB_CHECK_INTERVAL_MS = 12 * 3600 * 1000UL;
const unsigned long INACTIVE_SUB_CHECK_INTERVAL_MS = 5 * 60 * 1000UL; // 5 minutos
const unsigned long UPDATE_CHECK_INTERVAL_MS = 4 * 3600 * 1000UL;
// --> MEJORA v6.0: Intervalos de rotación de pantalla dinámicos
const unsigned long SCREEN_CONSUMPTION_INTERVAL_MS = 30000; // 30 segundos
const unsigned long SCREEN_OTHER_INTERVAL_MS = 15000; // 15 segundos
const unsigned long DAILY_RESTART_INTERVAL_MS = 24 * 3600 * 1000UL;
const unsigned long WIFI_CHECK_INTERVAL_MS = 30000;
const unsigned long REMOTE_CAL_CHECK_INTERVAL_MS = 4 * 3600 * 1000UL; // --> MEJORA v6.0: Intervalo para chequeo de calibración remota

// Configuración del Watchdog y Pulsación Larga
#define WDT_TIMEOUT_SECONDS 180
#define LONG_PRESS_DURATION_MS 10000 // 10 segundos

// --> MEJORA v6.0: Configuración del buffer en cola
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
int buffer_file_count = 0; // --> MEJORA v6.0: Contador de archivos en buffer

// Variables de Control
unsigned long last_measurement_time = 0;
unsigned long last_update_check = 0;
unsigned long last_activation_check = 0;
unsigned long last_button_press = 0;
unsigned long last_screen_change_time = 0;
unsigned long last_wifi_check = 0;
unsigned long last_remote_cal_check = 0; // --> MEJORA v6.0: Timer para calibración remota
unsigned long button_press_start_time = 0; // --> MEJORA v6.0: Timer para pulsación larga
bool button_is_pressed = false; // --> MEJORA v6.0: Estado del botón
int screen_mode = 0;
int lecturas_descartadas = 0;
const int LECTURAS_A_DESCARTAR = 10;


// --- 5. DECLARACIONES DE FUNCIONES (PROTOTIPOS) ---
void setupOLED();
void drawConsumptionScreen();
void drawDiagnosticsScreen(); // Dejar solo una
void drawServiceScreen();
void drawBootScreen();
void drawConfigScreen(const char* apName);
void drawUpdateScreen(String text);
void drawGenericMessage(String line1, String line2);
void drawPaymentDueScreen();
const char* getWifiIcon(int rssi);
void handleRestart();
void handleFactoryReset();

// --- FUNCIONES DE LÓGICA PRINCIPAL ---

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

    // Busca el último archivo para seguir escribiendo o crea uno nuevo
    for (int i = 0; i < MAX_BUFFER_FILES; i++) {
        filename = "/buffer_" + String(i) + ".txt";
        if (!SPIFFS.exists(filename)) {
            file_found = true;
            break;
        }
        // Si existe, revisa su tamaño
        File file = SPIFFS.open(filename, FILE_READ);
        if (file && file.size() < MAX_BUFFER_FILE_SIZE) {
            file.close();
            file_found = true;
            break;
        }
        if(file) file.close();
    }

    if (!file_found) {
        if (DEBUG_MODE) Serial.println("Buffer lleno, no se pueden crear más archivos. Dato descartado.");
        return;
    }

    File bufferFile = SPIFFS.open(filename, FILE_APPEND);
    if (bufferFile) {
        bufferFile.print(data_payload);
        bufferFile.close();
        if (DEBUG_MODE) Serial.printf("Dato guardado en buffer: %s\n", filename.c_str());
    } else {
        if (DEBUG_MODE) Serial.printf("Error al abrir %s para escritura.\n", filename.c_str());
    }
}

// --> MEJORA v6.0: Lógica para procesar y enviar datos desde la cola del buffer
void processBufferQueue() {
    if (WiFi.status() != WL_CONNECTED || !subscription_active) {
        return; // No intentar enviar si no hay conexión o suscripción
    }

    String filename;
    File bufferFile;
    bool file_to_send_found = false;

    // Buscar el archivo más antiguo para enviar
    for (int i = 0; i < MAX_BUFFER_FILES; i++) {
        filename = "/buffer_" + String(i) + ".txt";
        if (SPIFFS.exists(filename)) {
            bufferFile = SPIFFS.open(filename, FILE_READ);
            if (bufferFile && bufferFile.size() > 0) {
                file_to_send_found = true;
                break;
            }
            if(bufferFile) bufferFile.close();
        }
    }
    
    if (!file_to_send_found) {
        return; // No hay nada que enviar
    }

    if (DEBUG_MODE) Serial.printf("Intentando enviar buffer: %s\n", filename.c_str());

    String payload_to_send = bufferFile.readString();
    bufferFile.close();

    HTTPClient http;
    http.begin(INFLUXDB_URL);
    http.addHeader("Authorization", "Token " INFLUXDB_TOKEN);
    http.addHeader("Content-Type", "text/plain");
    
    int httpCode = http.POST(payload_to_send);
    server_status = (httpCode >= 200 && httpCode < 300);

    if (server_status) {
        if (DEBUG_MODE) Serial.printf("Buffer %s enviado a InfluxDB correctamente. Eliminando archivo.\n", filename.c_str());
        SPIFFS.remove(filename);
    } else {
        if (DEBUG_MODE) Serial.printf("Error al enviar buffer %s. Codigo HTTP: %d. Reintentando más tarde.\n", filename.c_str(), httpCode);
    }
    http.end();
}

// --> Contacta al servidor para verificar el estado de la suscripción
void checkSubscriptionStatus() {
    if (WiFi.status() != WL_CONNECTED) {
        if (DEBUG_MODE) Serial.println("Chequeo de suscripción omitido: sin WiFi.");
        return;
    }
    if (DEBUG_MODE) Serial.println("Verificando estado de la suscripcion...");
    
    String deviceId = WiFi.macAddress();
    deviceId.replace(":", "");
    String urlConId = String(ACTIVATION_CHECK_URL) + "?deviceId=" + deviceId;
    
    if (DEBUG_MODE) Serial.printf("URL de petición: %s\n", urlConId.c_str());

    HTTPClient http;
    http.begin(urlConId);
    http.addHeader("Authorization", "Bearer " + String(SUPABASE_ANON_KEY));
    int httpCode = http.GET();

    if (httpCode == HTTP_CODE_OK) {
        String payload = http.getString();
        payload.trim();
        if (DEBUG_MODE) Serial.printf("Respuesta del servidor de suscripción: %s\n", payload.c_str());

        int delimiterPos = payload.indexOf('|');
        if (delimiterPos > -1) {
            String statusStr = payload.substring(0, delimiterPos);
            String daysStr = payload.substring(delimiterPos + 1);
            subscription_active = (statusStr == "active");
            dias_de_gracia_restantes = daysStr.toInt();
            pago_vencido = !subscription_active;
        } else {
            if(DEBUG_MODE) Serial.println("Respuesta del servidor con formato inesperado.");
            subscription_active = false;
            pago_vencido = true;
            dias_de_gracia_restantes = 0;
        }

        if (DEBUG_MODE) {
            Serial.printf("Estado de la suscripción: %s\n", subscription_active ? "ACTIVA" : "INACTIVA");
            if (pago_vencido) Serial.printf("Días de gracia restantes: %d\n", dias_de_gracia_restantes);
        }
    } else {
        if (DEBUG_MODE) Serial.printf("Error al verificar suscripcion. Codigo HTTP: %d. Payload: %s\n", httpCode, http.getString().c_str());
        server_status = false;
    }
    http.end();
}

// --> Busca actualizaciones de firmware remotas vía HTTP
void checkForHttpUpdate() {
    if (WiFi.status() != WL_CONNECTED) return;
    if (DEBUG_MODE) Serial.println("Buscando actualizaciones de firmware...");
    if (OLED_CONECTADA) drawUpdateScreen("Buscando...");

    HTTPClient http;
    http.begin(FIRMWARE_VERSION_URL);
    int httpCode = http.GET();

    if (httpCode == HTTP_CODE_OK) {
        String version_str = http.getString();
        version_str.trim();
        float new_version = version_str.toFloat();
        if (DEBUG_MODE) Serial.printf("Version actual: %.1f, Version en servidor: %.1f\n", FIRMWARE_VERSION, new_version);

        if (new_version > FIRMWARE_VERSION) {
            if (DEBUG_MODE) Serial.println("Nueva version disponible. Actualizando...");
            if (OLED_CONECTADA) drawUpdateScreen("Descargando");

            HTTPClient httpUpdateClient;
            httpUpdateClient.begin(FIRMWARE_BIN_URL);
            t_httpUpdate_return ret = httpUpdate.update(httpUpdateClient);

            if (ret == HTTP_UPDATE_FAILED) {
                if (DEBUG_MODE) Serial.printf("Actualizacion Fallida. Error (%d): %s\n", httpUpdate.getLastError(), httpUpdate.getLastErrorString().c_str());
                if (OLED_CONECTADA) drawUpdateScreen("Error!");
                delay(2000);
            }
        } else {
            if (DEBUG_MODE) Serial.println("El firmware ya esta actualizado.");
        }
    } else {
        if (DEBUG_MODE) Serial.printf("Error al verificar version. Codigo HTTP: %d\n", httpCode);
    }
    http.end();
}

// --> MEJORA v6.0: Arquitectura para futura calibración remota
void checkForRemoteCalibration() {
    if (WiFi.status() != WL_CONNECTED) {
        if (DEBUG_MODE) Serial.println("Chequeo de calibracion remota omitido: sin WiFi.");
        return;
    }

    if (DEBUG_MODE) Serial.println("Buscando calibracion remota...");

    String deviceId = WiFi.macAddress();
    deviceId.replace(":", "");
    String urlConId = String(CALIBRATION_CHECK_URL) + "?deviceId=" + deviceId;

    HTTPClient http;
    http.begin(urlConId);
    http.addHeader("Authorization", "Bearer " + String(SUPABASE_ANON_KEY));
    int httpCode = http.GET();

    if (httpCode == HTTP_CODE_OK) {
        String payload = http.getString();
        StaticJsonDocument<256> doc;
        DeserializationError error = deserializeJson(doc, payload);

        if (error) {
            if (DEBUG_MODE) Serial.printf("Error al parsear JSON de calibracion: %s\n", error.c_str());
            http.end();
            return;
        }

        bool update_available = doc["update_available"];

        if (update_available) {
            if (DEBUG_MODE) Serial.println("¡Nuevos datos de calibracion recibidos del servidor!");
            
            // Extraer y aplicar los nuevos valores
            voltage_cal = doc["values"]["voltage"];
            current_cal_1 = doc["values"]["current1"];
            current_cal_2 = doc["values"]["current2"];

            if (DEBUG_MODE) {
                Serial.printf("Nuevos valores -> V_CAL: %.2f, I_CAL1: %.2f, I_CAL2: %.2f\n", voltage_cal, current_cal_1, current_cal_2);
            }
            
            // Guardar permanentemente la nueva calibración en SPIFFS
            saveCalibration();
            if (DEBUG_MODE) Serial.println("Nueva calibracion guardada en memoria.");

        } else {
            if (DEBUG_MODE) Serial.println("No hay actualizaciones de calibracion pendientes.");
        }

    } else {
        if (DEBUG_MODE) Serial.printf("Error al chequear calibracion remota. Codigo HTTP: %d\n", httpCode);
    }

    http.end();
}

// --> Realiza las mediciones y decide si enviar los datos o guardarlos en el buffer
// --> MEJORA v6.0: La función ahora solo mide y decide si enviar en vivo o guardar en buffer.
void measureAndStoreData() {
    emon1.calcVI(20, 2000);
    emon1.calcIrms(1480);
    emon2.calcIrms(1480);

    latest_vrms = emon1.Vrms;
    latest_power = emon1.realPower;
    latest_irms1 = emon1.Irms;
    latest_irms2 = emon2.Irms;
    latest_temp_cpu = temperatureRead();

    if (isnan(latest_vrms) || isinf(latest_vrms) || isnan(latest_irms1) || isinf(latest_irms1)) {
        if (DEBUG_MODE) Serial.println("Lectura inválida (NaN/Inf) descartada.");
        return;
    }

    if (latest_vrms < 30.0) latest_vrms = 0.0;
    if (latest_irms1 < 0.05) latest_irms1 = 0.0;
    if (latest_irms2 < 0.05) latest_irms2 = 0.0;
    if (latest_vrms == 0.0 || latest_irms1 == 0.0) latest_power = 0.0;
    latest_leakage = abs(latest_irms1 - latest_irms2);

    if (DEBUG_MODE) {
        Serial.println("\n--- Telemetria de Estado ---");
        Serial.printf("Voltaje: %.1f V | Potencia: %.0f W\n", latest_vrms, latest_power);
        Serial.printf("C. Fase: %.3f A | C. Neutro: %.3f A | Fuga: %.3f A\n", latest_irms1, latest_irms2, latest_leakage);
    }

    char data_payload[256];
    sprintf(data_payload, "%s,device=LETE-%04X vrms=%.2f,irms1=%.3f,irms2=%.3f,power=%.2f,leakage=%.3f\n",
            INFLUXDB_MEASUREMENT, (uint16_t)ESP.getEfuseMac(),
            latest_vrms, latest_irms1, latest_irms2, latest_power, latest_leakage);

    // Intenta enviar en vivo si hay conexión y suscripción
    if (WiFi.status() == WL_CONNECTED && subscription_active) {
        HTTPClient http;
        http.begin(INFLUXDB_URL);
        http.addHeader("Authorization", "Token " INFLUXDB_TOKEN);
        http.addHeader("Content-Type", "text/plain");
        int httpCode = http.POST(data_payload);
        server_status = (httpCode >= 200 && httpCode < 300);

        if (server_status) {
            if (DEBUG_MODE) Serial.println("Dato en vivo enviado a InfluxDB correctamente.");
        } else {
            if (DEBUG_MODE) Serial.printf("Error al enviar dato en vivo. Codigo HTTP: %d. Guardando en buffer.\n", httpCode);
            writeToBuffer(data_payload);
        }
        http.end();
    } else {
        // Si no hay conexión o suscripción, guarda directamente en el buffer
        server_status = false;
        writeToBuffer(data_payload);
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

// --- FUNCIÓN DE SETUP ---
void setup() {
    Serial.begin(115200);
    pinMode(BUTTON_PIN, INPUT_PULLUP);

    // 1. Configuración del Watchdog Timer (Correcta y conservada)
    if (DEBUG_MODE) Serial.println("Configurando Watchdog Timer...");
    esp_task_wdt_config_t wdt_config = {
    .timeout_ms = WDT_TIMEOUT_SECONDS * 1000,
    .idle_core_mask = (1 << portNUM_PROCESSORS) - 1, // <-- Orden correcto
    .trigger_panic = true,
    };
    esp_task_wdt_init(&wdt_config); // Se inicializa pasando la configuración
    esp_task_wdt_add(NULL);         // Se añade la tarea actual a la vigilancia

    // 2. Inicialización de periféricos básicos
    setupOLED();

    if (!SPIFFS.begin(true)) {
        if (DEBUG_MODE) Serial.println("Error crítico al montar SPIFFS. Reiniciando en 5s...");
        delay(5000);
        ESP.restart();
    }
    if (DEBUG_MODE) Serial.println("SPIFFS montado.");

    // 3. Carga de configuración y mensaje de arranque
    loadCalibration();
    drawGenericMessage("Luz en tu Espacio", "Iniciando...");
    
    // 4. Inicialización de los sensores de EmonLib (se hace una sola vez)
    emon1.voltage(VOLTAGE_SENSOR_PIN, voltage_cal, 1.7);
    emon1.current(CURRENT_SENSOR_PIN_1, current_cal_1);
    emon2.current(CURRENT_SENSOR_PIN_2, current_cal_2);

    // 5. Nuevo método de conexión WiFi (sin autoConnect que bloquea)
    WiFi.mode(WIFI_STA);
    WiFi.begin(); // Intenta conectar con las credenciales guardadas

    if (DEBUG_MODE) Serial.print("Conectando a WiFi...");
    
    byte Cnt = 0;
    while (WiFi.status() != WL_CONNECTED && Cnt < 30) { // Intenta por ~15 segundos
        Cnt++;
        delay(500);
        Serial.print(".");
        esp_task_wdt_reset(); // Alimenta al watchdog durante la espera
    }

    if (WiFi.status() == WL_CONNECTED) {
        if (DEBUG_MODE) {
            Serial.println("\nConectado a la red Wi-Fi!");
            Serial.print("Dirección IP: ");
            Serial.println(WiFi.localIP());
        }
    } else {
        if (DEBUG_MODE) Serial.println("\nNo se pudo conectar al WiFi guardado. Se reintentará en el loop.");
    }
    
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
        if (DEBUG_MODE) Serial.println("Hora sincronizada con NTP.");
        time_synced = true;
    } else {
        if (DEBUG_MODE) Serial.println("Fallo al sincronizar hora NTP después de 5 intentos.");
        time_synced = false;
    }
    
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

    // 8. Chequeo inicial de la suscripción
    int sub_retry_count = 0;
    while (!subscription_active && sub_retry_count < 3) {
        if (DEBUG_MODE && sub_retry_count > 0) Serial.printf("Suscripción inactiva. Reintentando... (%d/3)\n", sub_retry_count + 1);
        checkSubscriptionStatus();
        if (subscription_active) break;
        sub_retry_count++;
        delay(2000);
        esp_task_wdt_reset();
    }

    // 9. Chequeo inicial de actualización de firmware
    delay(100);
    checkForHttpUpdate();
}

// --- FUNCIÓN DE LOOP PRINCIPAL ---
void loop() {
    // 1. Tareas de Mantenimiento Esenciales (se ejecutan en cada ciclo)
    esp_task_wdt_reset();
    unsigned long currentMillis = millis();
    ArduinoOTA.handle();
    server.handleClient();

    // 2. Lógica de Pulsación Larga (Modo Configuración)
    if (digitalRead(BUTTON_PIN) == LOW) {
        if (!button_is_pressed) {
            // Se acaba de presionar el botón, iniciar el temporizador
            button_press_start_time = currentMillis;
            button_is_pressed = true;
        } else {
            // El botón se mantiene presionado, verificar si ya pasaron los 10 segundos
            if (currentMillis - button_press_start_time > LONG_PRESS_DURATION_MS) {
                if (DEBUG_MODE) Serial.println("Pulsacion larga detectada. Iniciando modo configuracion...");
                if(OLED_CONECTADA) drawGenericMessage("Modo Configuracion", "Soltar boton...");
                
                WiFiManager wm;
                wm.setConfigPortalTimeout(180);
                if (wm.startConfigPortal("LETE-Monitor-Config")) {
                    if(OLED_CONECTADA) drawGenericMessage("Config OK", "Reiniciando...");
                } else {
                    if(OLED_CONECTADA) drawGenericMessage("Config Fallo", "Reiniciando...");
                }
                delay(2000);
                ESP.restart();
            }
        }
    } else {
        // El botón no está presionado, resetear el estado
        button_is_pressed = false;
    }

    // 3. Tareas Periódicas (se ejecutan cada cierto tiempo)
    
    // Chequeo de conexión WiFi
    if (currentMillis - last_wifi_check > WIFI_CHECK_INTERVAL_MS) {
        last_wifi_check = currentMillis;
        if (WiFi.status() != WL_CONNECTED) {
            if (DEBUG_MODE) Serial.println("Wi-Fi desconectado. Intentando reconectar...");
            WiFi.reconnect();
        }
    }

    // Chequeo de suscripción (lógica adaptable)
    unsigned long next_check_interval = subscription_active ? ACTIVE_SUB_CHECK_INTERVAL_MS : INACTIVE_SUB_CHECK_INTERVAL_MS;
    if (currentMillis - last_activation_check > next_check_interval) {
        last_activation_check = currentMillis;
        checkSubscriptionStatus();
    }

    // Chequeo de actualización de firmware
    if (currentMillis - last_update_check > UPDATE_CHECK_INTERVAL_MS) {
        last_update_check = currentMillis;
        checkForHttpUpdate();
    }

    // Chequeo de calibración remota (placeholder)
    if (currentMillis - last_remote_cal_check > REMOTE_CAL_CHECK_INTERVAL_MS) {
        last_remote_cal_check = currentMillis;
        checkForRemoteCalibration();
    }

    // Medición y almacenamiento de datos
    if (currentMillis - last_measurement_time > MEASUREMENT_INTERVAL_MS) {
        last_measurement_time = currentMillis;
        if (lecturas_descartadas < LECTURAS_A_DESCARTAR) {
            emon1.calcVI(20, 2000);
            lecturas_descartadas++;
        } else {
            measureAndStoreData();
        }
    }

    // 4. Procesamiento de la Cola del Buffer y actualización del contador
    processBufferQueue();
    buffer_file_count = countBufferFiles();

    // 5. Lógica de Pantalla OLED (con rotación dinámica)
    if (OLED_CONECTADA) {
        unsigned long current_rotation_interval = (screen_mode == 0) ? SCREEN_CONSUMPTION_INTERVAL_MS : SCREEN_OTHER_INTERVAL_MS;
        
        // Cambiar de pantalla si el botón se presiona brevemente
        if (digitalRead(BUTTON_PIN) == LOW && (currentMillis - last_button_press > 500)) {
            last_button_press = currentMillis;
            screen_mode = (screen_mode + 1) % 3;
            last_screen_change_time = currentMillis; // Resetear timer de rotación
        }
        
        // Rotar pantalla automáticamente si ha pasado el tiempo
        if (currentMillis - last_screen_change_time > current_rotation_interval) {
            screen_mode = (screen_mode + 1) % 3;
            last_screen_change_time = currentMillis;
        }

        // Mostrar la pantalla correspondiente
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
    
    // 6. Reinicio diario programado (última comprobación)
    if (currentMillis > DAILY_RESTART_INTERVAL_MS) {
        if (DEBUG_MODE) Serial.println("Reinicio diario programado. Reiniciando...");
        delay(1000);
        ESP.restart();
    }
}

// --- INCLUSIÓN DE ARCHIVOS SEPARADOS ---
#include "oled_screens.h"