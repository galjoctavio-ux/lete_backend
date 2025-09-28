/*
==========================================================================
== FIRMWARE LETE - MONITOR DE ENERGÍA v8.1
==
== RESUMEN DE CAMBIOS v8.0 (Basado en análisis de robustez):
== - SINCRONIZACIÓN DE NÚCLEOS: Implementados Mutex para proteger el acceso
==   a SPIFFS y variables globales, eliminando condiciones de carrera.
== - SEGURIDAD DE MEMORIA: Reemplazado sprintf() por snprintf() en todo el
==   código para prevenir desbordamientos de buffer.
== - ROBUSTEZ DE RED: Aumentado el stack de la tarea de red a 16KB, añadidos
==   timeouts a todas las peticiones HTTP, incluyendo la actualización OTA.
== - VALIDACIÓN DE ENTRADAS: Añadida validación de rangos en la página de
==   calibración para evitar la corrupción de datos por valores inválidos.
== - MANEJO DE ERRORES MEJORADO: Lógica de reinicio diario corregida para ser
==   independiente del desbordamiento de millis() y comprobación de errores
==   en la deserialización de JSON.
== - CORRECCIONES DE HARDWARE: Añadida inicialización de Wire.begin() para
==   el bus I2C y documentado el riesgo de usar GPIO0.
== - EFICIENCIA: Refactorizada la generación de HTML en el servidor web para
==   reducir la fragmentación de memoria usando envío por trozos.
=========================================================================
*/


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
const float FIRMWARE_VERSION = 8.2; 
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
const unsigned long SERVER_TASKS_INTERVAL_MS = 900 * 1000UL; // --> AÑADIDO v7.0: Chequeos al servidor cada 4h
unsigned long bootTime = 0;
const unsigned long BUFFER_HEALTH_CHECK_INTERVAL_MS = 60 * 1000UL; // Chequeo de salud del buffer cada minuto

// Configuración del Watchdog y Pulsación Larga
#define WDT_TIMEOUT_SECONDS 180
#define LONG_PRESS_DURATION_MS 10000 // 10 segundos

// --> CONFIGURACIÓN OPTIMIZADA DEL BUFFER v8.2
#define MAX_BUFFER_FILE_SIZE 1024      // 1KB por archivo
#define MAX_BUFFER_FILES 100           // Aumentado a 100 archivos (800KB total)
#define BUFFER_ROTATION_SIZE 80        // Opcional: para futuras lógicas de rotación
#define MAX_MEASUREMENTS_PER_FILE 200  // Límite de mediciones por archivo
#define BUFFER_BATCH_SIZE 5            // Enviar hasta 5 mediciones por lote
#define MAX_QUEUE_SIZE 20              // Aumentado el tamaño de cola en memoria

// --> NUEVAS CONFIGURACIONES PARA ROBUSTEZ v8.2
#define MAX_RETRY_ATTEMPTS 3           // Máximo reintentos por medición
#define CONNECTION_TIMEOUT_MS 10000    // Timeout para conexiones HTTP
#define WIFI_RECONNECT_ATTEMPTS 5      // Intentos de reconexión WiFi
#define DATA_COMPRESSION_LEVEL 1       // Nivel de compresión (1=básico)

// --- 3. CONFIGURACIÓN DE PINES ---
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define I2C_SDA 21
#define I2C_SCL 22
const int VOLTAGE_SENSOR_PIN = 34;
const int CURRENT_SENSOR_PIN_1 = 35;
const int CURRENT_SENSOR_PIN_2 = 32;
// --- 3. CONFIGURACIÓN DE PINES ---
// ...
// ¡¡¡ADVERTENCIA!!! GPIO0 es un pin de strapping. Mantenerlo presionado
// durante el arranque puede impedir que el dispositivo inicie en modo normal.
// Considerar usar un pin diferente en futuras revisiones de hardware.
#define BUTTON_PIN 0 

// --- 4. OBJETOS Y VARIABLES GLOBALES ---
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
WebServer server(80);
EnergyMonitor emon1, emon2;

// --> ESTRUCTURA MEJORADA PARA MEDICIONES v8.2
struct MeasurementData {
    uint32_t sequence_number;  // Número de secuencia para detectar pérdidas
    uint32_t timestamp;        // Timestamp Unix
    float vrms;
    float irms1;
    float irms2;
    float power;
    float leakage;
    float temp_cpu;
    uint8_t quality_flag;      // 0=OK, 1=Estimado, 2=Degradado
};

// --> ESTRUCTURA PARA MÉTRICAS DE SALUD DEL BUFFER v8.2
struct BufferHealthMetrics {
    uint32_t total_measurements_taken;
    uint32_t measurements_sent_live;
    uint32_t measurements_buffered;
    uint32_t measurements_lost;
    uint32_t buffer_overflows;
    uint32_t network_failures;
    float buffer_usage_percent;
    uint32_t oldest_buffered_timestamp;
};

QueueHandle_t dataQueue;

BufferHealthMetrics buffer_health = {0};

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

// --> NUEVAS VARIABLES PARA CONTROL AVANZADO v8.2
uint32_t global_sequence_number = 0;
uint32_t last_sent_sequence = 0;
bool wifi_connection_stable = false;
uint8_t wifi_reconnect_attempts = 0;
unsigned long last_buffer_health_check = 0;
int current_buffer_file_index = 0;

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

// --> AÑADIDO v8.0: Mutex para proteger recursos compartidos
SemaphoreHandle_t spiffsMutex;
SemaphoreHandle_t sharedVarsMutex;
SemaphoreHandle_t bufferMetricsMutex; // Proteger métricas del buffer


// --- 5. DECLARACIONES DE FUNCIONES v8.2 ---

// Tarea del Núcleo 0
void networkTask(void * pvParameters);

// Lógica Principal y de Medición
void saveCalibration();
void loadCalibration();
void measureAndStoreData();

// Funciones de Buffer Optimizadas
int countBufferFiles();
void writeToBuffer(const MeasurementData& data);
void processBufferQueue();
bool sendDataToInflux(const MeasurementData& data);
bool sendBatchToInflux(const MeasurementData* dataArray, int count);
void rotateBufferFiles();
String compressDataPayload(const MeasurementData& data);
MeasurementData decompressDataPayload(const String& compressed);

// Funciones de Salud y Recuperación
void updateBufferHealthMetrics();
void checkBufferHealth();
bool isWifiConnectionStable();
void handleNetworkRecovery();

// Tareas de Servidor
void checkServerTasks();
void checkForHttpUpdate();

// Funciones de Servidor Web
void handleRoot();
void handleUpdate();
void handleResetWifi();
void handleCalibration();
void handleRestart();
void handleFactoryReset();
void handleBufferStats(); // Nueva página

// Funciones de Pantalla OLED
void setupOLED();
void drawConsumptionScreen();
void drawDiagnosticsScreen();
void drawServiceScreen();
void drawConfigScreen(const char* apName);
void drawUpdateScreen(String text);
void drawGenericMessage(String line1, String line2);
void drawPaymentDueScreen();
void drawBufferHealthScreen(); // Nueva pantalla
const char* getWifiIcon(int rssi);

// --- FUNCIONES DE LÓGICA PRINCIPAL ---

// --- Tarea de Red Optimizada con Manejo Inteligente de Prioridades ---
void networkTask(void * pvParameters) {
    if (DEBUG_MODE) Serial.println("Tarea de Red v8.2 iniciada en Núcleo 0.");
    esp_task_wdt_add(NULL);

    unsigned long last_ntp_sync_attempt = 0;
    MeasurementData batch_buffer[BUFFER_BATCH_SIZE];
    int batch_count = 0;

    for (;;) {
        esp_task_wdt_reset();
        
        wifi_connection_stable = isWifiConnectionStable();

        if (wifi_connection_stable) {
            
            // Sincronización NTP
            if (!time_synced && millis() - last_ntp_sync_attempt > NTP_RETRY_INTERVAL_MS) {
                last_ntp_sync_attempt = millis();
                if (DEBUG_MODE) Serial.println("[N0] Reintentando sincronización NTP...");
                configTime(0, 0, NTP_SERVER);
                
                struct tm timeinfo;
                if (getLocalTime(&timeinfo)) {
                    if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                        time_synced = true;
                        xSemaphoreGive(sharedVarsMutex);
                    }
                    if (DEBUG_MODE) Serial.println("[N0] Hora NTP sincronizada.");
                } else {
                    if (DEBUG_MODE) Serial.println("[N0] Fallo en sincronización NTP.");
                }
            }

            // --- PROCESAMIENTO EN LOTES PARA MAYOR EFICIENCIA ---
            MeasurementData receivedData;
            bool data_available = false;
            
            // Recolectar datos de la cola en lotes
            while (batch_count < BUFFER_BATCH_SIZE && 
                   xQueueReceive(dataQueue, &receivedData, 0) == pdTRUE) {
                batch_buffer[batch_count] = receivedData;
                batch_count++;
                data_available = true;
            }
            
            // Enviar lote si hay datos
            if (data_available && batch_count > 0) {
                if (batch_count == 1) { // Un solo dato, envío individual
                    sendDataToInflux(batch_buffer[0]);
                } else { // Múltiples datos, envío en lote
                    sendBatchToInflux(batch_buffer, batch_count);
                }
                batch_count = 0; // Resetear contador de lote
            }
            
            // Si la cola en vivo está vacía, procesar buffer almacenado
            if (!data_available && countBufferFiles() > 0) {
                if (DEBUG_MODE) Serial.println("[N0] Procesando datos del buffer...");
                processBufferQueue();
            }

            // Tareas de servidor
            if (millis() - last_server_tasks_check > SERVER_TASKS_INTERVAL_MS) {
                last_server_tasks_check = millis();
                checkServerTasks();
            }
            
        } else {
            handleNetworkRecovery();
        }
        
        // Chequeo de salud del buffer
        if (millis() - last_buffer_health_check > BUFFER_HEALTH_CHECK_INTERVAL_MS) {
            last_buffer_health_check = millis();
            checkBufferHealth();
        }
        
        vTaskDelay(pdMS_TO_TICKS(200));
    }
}

// --> Guarda los valores de calibración en la memoria permanente (SPIFFS)
void saveCalibration() {
    // Tomamos el control de SPIFFS. Esperamos hasta 1000ms si no está disponible.
    if (xSemaphoreTake(spiffsMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
        File file = SPIFFS.open("/calibracion.tmp", FILE_WRITE);
        if (!file) {
            if (DEBUG_MODE) Serial.println("Error al abrir archivo temporal de calibracion");
            xSemaphoreGive(spiffsMutex); // Liberamos el mutex antes de salir
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
            // Si la escritura fue exitosa, reemplazar el archivo original
            SPIFFS.remove("/calibracion.json");
            SPIFFS.rename("/calibracion.tmp", "/calibracion.json");
            if (DEBUG_MODE) Serial.println("Archivo de calibracion actualizado.");
        }
        file.close(); // Siempre cerramos el archivo

        // Liberamos el control de SPIFFS
        xSemaphoreGive(spiffsMutex);
        if (DEBUG_MODE) Serial.println("Mutex de SPIFFS liberado en saveCalibration.");
    } else {
        if (DEBUG_MODE) Serial.println("Timeout al esperar el mutex de SPIFFS en saveCalibration.");
    }
}

// --> Carga los valores de calibración desde SPIFFS al arrancar
void loadCalibration() {
    if (xSemaphoreTake(spiffsMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
        if (SPIFFS.exists("/calibracion.json")) {
            File file = SPIFFS.open("/calibracion.json", FILE_READ);
            if (!file) {
                if (DEBUG_MODE) Serial.println("No se pudo abrir el archivo de calibracion");
                xSemaphoreGive(spiffsMutex); // Liberar en caso de error
                return;
            }

            StaticJsonDocument<256> doc;
            DeserializationError error = deserializeJson(doc, file);
            if (error) {
                if (DEBUG_MODE) Serial.printf("Error al leer archivo de calibracion: %s\n", error.c_str());
                file.close();
                xSemaphoreGive(spiffsMutex); // Liberar en caso de error
                return;
            }
            
            if (doc.containsKey("voltage_cal")) voltage_cal = doc["voltage_cal"];
            if (doc.containsKey("current_cal_1")) current_cal_1 = doc["current_cal_1"];
            if (doc.containsKey("current_cal_2")) current_cal_2 = doc["current_cal_2"];
            
            if (DEBUG_MODE) Serial.println("Calibracion cargada desde SPIFFS.");
            file.close();
        } else {
            if (DEBUG_MODE) Serial.println("No se encontro archivo de calibracion, guardando valores por defecto.");
            // saveCalibration() ya maneja su propio mutex, pero como ya lo tenemos,
            // lo liberamos antes de llamar para evitar un deadlock.
            xSemaphoreGive(spiffsMutex);
            saveCalibration();
            // Como saveCalibration ya liberó su propio mutex, no necesitamos liberarlo de nuevo.
            // Retornamos para evitar la doble liberación al final de la función.
            return; 
        }

        xSemaphoreGive(spiffsMutex);
        if (DEBUG_MODE) Serial.println("Mutex de SPIFFS liberado en loadCalibration.");
    } else {
        if (DEBUG_MODE) Serial.println("Timeout al esperar el mutex de SPIFFS en loadCalibration.");
    }
}

// --- Función Mejorada para Escribir al Buffer con Compresión ---
void writeToBuffer(const MeasurementData& data) {
    if (xSemaphoreTake(spiffsMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
        String filename;
        File bufferFile;
        
        filename = "/buffer_" + String(current_buffer_file_index) + ".txt";
        
        bool needs_rotation = false;
        if (SPIFFS.exists(filename)) {
            bufferFile = SPIFFS.open(filename, FILE_READ);
            if (bufferFile && bufferFile.size() >= MAX_BUFFER_FILE_SIZE) {
                needs_rotation = true;
            }
            if (bufferFile) bufferFile.close();
        }

        if (needs_rotation || countBufferFiles() >= MAX_BUFFER_FILES) {
            rotateBufferFiles();
            current_buffer_file_index = (current_buffer_file_index + 1) % MAX_BUFFER_FILES;
            filename = "/buffer_" + String(current_buffer_file_index) + ".txt";
            
            if (xSemaphoreTake(bufferMetricsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                buffer_health.buffer_overflows++;
                xSemaphoreGive(bufferMetricsMutex);
            }
        }

        String compressed_data = compressDataPayload(data);
        bufferFile = SPIFFS.open(filename, FILE_APPEND);
        if (bufferFile) {
            bufferFile.println(compressed_data);
            bufferFile.close();
            
            if (DEBUG_MODE) Serial.printf("[N0] Medición %u guardada en %s\n", data.sequence_number, filename.c_str());
            
            if (xSemaphoreTake(bufferMetricsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                buffer_health.measurements_buffered++;
                xSemaphoreGive(bufferMetricsMutex);
            }
        }
        
        xSemaphoreGive(spiffsMutex);
    } else {
        if (DEBUG_MODE) Serial.println("Timeout en writeToBuffer.");
        if (xSemaphoreTake(bufferMetricsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
            buffer_health.measurements_lost++;
            xSemaphoreGive(bufferMetricsMutex);
        }
    }
}

// --- Función Mejorada para Envío Individual con Reintentos ---
bool sendDataToInflux(const MeasurementData& data) {
    bool sub_activa_local = false;
    int dias_gracia_local = 0;
    if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        sub_activa_local = subscription_active;
        dias_gracia_local = dias_de_gracia_restantes;
        xSemaphoreGive(sharedVarsMutex);
    }
    
    if (WiFi.status() != WL_CONNECTED || (!sub_activa_local && dias_gracia_local <= 0)) {
        writeToBuffer(data);
        return false;
    }

    // VALIDACIÓN ADICIONAL DE DATOS
    if (isnan(data.vrms) || isinf(data.vrms) || isnan(data.power) || isinf(data.power)) {
        if (DEBUG_MODE) Serial.printf("[N0] Datos inválidos en medición %u, descartando.\n", data.sequence_number);
        return false;
    }

    // --- FORMATO FINAL Y CORRECTO DE INFLUXDB LINE PROTOCOL ---
    // Sintaxis: measurement,tag_set field_set timestamp
    // Nota el ESPACIO entre el tag (device) y el primer field (vrms)
    char influx_payload[400];
    snprintf(influx_payload, sizeof(influx_payload),
        "%s,device=LETE-%04X vrms=%.2f,irms1=%.3f,irms2=%.3f,power=%.2f,leakage=%.3f,cpu_temp=%.1f,quality=%u,seq=%u %llu",
        INFLUXDB_MEASUREMENT, (uint16_t)ESP.getEfuseMac(),
        data.vrms, data.irms1, data.irms2, data.power, data.leakage, data.temp_cpu,
        data.quality_flag, data.sequence_number, (unsigned long long)data.timestamp);

    if (DEBUG_MODE) {
        Serial.printf("[N0] Payload InfluxDB: %s\n", influx_payload);
    }

    for (int attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
        HTTPClient http;
        http.setTimeout(CONNECTION_TIMEOUT_MS);
        http.begin(INFLUXDB_URL);
        http.addHeader("Authorization", "Token " INFLUXDB_TOKEN);
        http.addHeader("Content-Type", "text/plain");
        
        int httpCode = http.POST(influx_payload);
        bool success = (httpCode >= 200 && httpCode < 300);
        http.end();

        if (success) {
            if (xSemaphoreTake(bufferMetricsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                buffer_health.measurements_sent_live++;
                xSemaphoreGive(bufferMetricsMutex);
            }
            if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                server_status = true;
                xSemaphoreGive(sharedVarsMutex);
            }
            if (DEBUG_MODE) Serial.printf("[N0] Medición %u enviada exitosamente.\n", data.sequence_number);
            return true;
        } else {
            if (DEBUG_MODE) Serial.printf("[N0] Intento %d fallo (HTTP:%d) para medición %u\n", attempt + 1, httpCode, data.sequence_number);
            if (attempt < MAX_RETRY_ATTEMPTS - 1) {
                vTaskDelay(pdMS_TO_TICKS(1000 * (1 << attempt)));
            }
        }
    }
    
    writeToBuffer(data);
    if (xSemaphoreTake(bufferMetricsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        buffer_health.network_failures++;
        xSemaphoreGive(bufferMetricsMutex);
    }
    if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        server_status = false;
        xSemaphoreGive(sharedVarsMutex);
    }
    return false;
}

// --> Lógica segura y optimizada para procesar la cola del buffer ---
void processBufferQueue() {
    // --- Lógica de decisión ---
    bool sub_activa_local = false;
    int dias_gracia_local = 0;
    if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        sub_activa_local = subscription_active;
        dias_gracia_local = dias_de_gracia_restantes;
        xSemaphoreGive(sharedVarsMutex);
    }

    if (WiFi.status() != WL_CONNECTED || (!sub_activa_local && dias_gracia_local <= 0)) {
        return;
    }

    String filename_to_process;
    String file_content; // Usaremos esta variable para leer el archivo

    // --- SECCIÓN CRÍTICA: LECTURA DEL ARCHIVO ---
    if (xSemaphoreTake(spiffsMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
        File bufferFile;
        for (int i = 0; i < MAX_BUFFER_FILES; i++) {
            String current_filename = "/buffer_" + String(i) + ".txt";
            if (SPIFFS.exists(current_filename)) {
                bufferFile = SPIFFS.open(current_filename, FILE_READ);
                if (bufferFile && bufferFile.size() > 0) {
                    filename_to_process = current_filename;
                    file_content = bufferFile.readString(); // Leemos en 'file_content'
                    bufferFile.close();
                    break;
                }
                if(bufferFile) bufferFile.close();
            }
        }
        xSemaphoreGive(spiffsMutex);
    } else {
        if (DEBUG_MODE) Serial.println("Timeout al esperar mutex en processBufferQueue (lectura).");
        return;
    }
    
    // --- CONSTRUCCIÓN Y ENVÍO DEL LOTE ---
    if (file_content.isEmpty()) return;

    if (DEBUG_MODE) Serial.printf("[N0] Archivo %s leído (%d bytes). Construyendo lote para enviar...\n", filename_to_process.c_str(), file_content.length());
    
    String batch_payload = "";
    int line_start = 0;
    
    // Construir un solo payload grande con todas las líneas del archivo
    while (line_start < file_content.length()) {
        int line_end = file_content.indexOf('\n', line_start);
        if (line_end == -1) line_end = file_content.length();
        
        String line = file_content.substring(line_start, line_end);
        line.trim();
        
        if (line.length() > 0) {
            MeasurementData data = decompressDataPayload(line);
            
            char influx_line[300];
            snprintf(influx_line, sizeof(influx_line),
                "%s,device=LETE-%04X vrms=%.2f,irms1=%.3f,irms2=%.3f,power=%.2f,leakage=%.3f,cpu_temp=%.1f,quality=%u,seq=%u %llu",
                INFLUXDB_MEASUREMENT, (uint16_t)ESP.getEfuseMac(),
                data.vrms, data.irms1, data.irms2, data.power, data.leakage, data.temp_cpu,
                data.quality_flag, data.sequence_number, (unsigned long long)data.timestamp);

            batch_payload += influx_line;
            batch_payload += "\n";
        }
        line_start = line_end + 1;
    }

    // Enviar el lote completo en una sola petición
    if (!batch_payload.isEmpty()) {
        HTTPClient http;
        http.setTimeout(CONNECTION_TIMEOUT_MS * 2);
        http.begin(INFLUXDB_URL);
        http.addHeader("Authorization", "Token " INFLUXDB_TOKEN);
        http.addHeader("Content-Type", "text/plain");
        
        int httpCode = http.POST(batch_payload);
        bool success = (httpCode >= 200 && httpCode < 300);
        http.end();

        if (success) {
            if (DEBUG_MODE) Serial.printf("[N0] ÉXITO: Buffer %s enviado. Eliminando archivo.\n", filename_to_process.c_str());
            if (xSemaphoreTake(spiffsMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
                SPIFFS.remove(filename_to_process);
                xSemaphoreGive(spiffsMutex);
            }
        } else {
            if (DEBUG_MODE) Serial.printf("[N0] FALLO: Error al enviar buffer %s. HTTP: %d.\n", filename_to_process.c_str(), httpCode);
        }
    }
}

// --> Función ÚNICA que agrupa todas las tareas pesadas del servidor, con validación JSON
void checkServerTasks() {
    if (WiFi.status() != WL_CONNECTED) return;
    if (DEBUG_MODE) Serial.println("\n[N0] Ejecutando tareas periódicas de servidor...");
    
    String deviceId = WiFi.macAddress();
    deviceId.replace(":", "");
    String urlConId = String(SERVER_TASKS_URL) + "?deviceId=" + deviceId;

    HTTPClient http;
    http.setTimeout(8000); // Aumentamos timeout para robustez
    //http.begin(TEST_FUNCTION_URL); 
    http.begin(urlConId);
    http.addHeader("apikey", String(SUPABASE_ANON_KEY));
    http.addHeader("Authorization", "Bearer " + String(SUPABASE_ANON_KEY));

    int httpCode = http.GET();

    if (httpCode == HTTP_CODE_OK) {
        String payload = http.getString();
        StaticJsonDocument<512> doc;
        
        // --> AÑADIDO: Verificación de error en la deserialización del JSON
        DeserializationError error = deserializeJson(doc, payload);
        if (error) {
            if (DEBUG_MODE) Serial.printf("[N0] Error al parsear JSON de tareas: %s\n", error.c_str());
            http.end();
            return; // Salimos para no procesar datos corruptos
        }

        // --- Tarea 1: Procesar Suscripción (con protección de mutex) ---
        if (doc.containsKey("subscription_payload")) {
            String sub_payload = doc["subscription_payload"];
            int first_pipe = sub_payload.indexOf('|');
            int second_pipe = sub_payload.indexOf('|', first_pipe + 1);
            if (first_pipe > 0 && second_pipe > first_pipe) {
                if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                    subscription_active = (sub_payload.substring(0, first_pipe) == "active");
                    dias_de_gracia_restantes = sub_payload.substring(first_pipe + 1, second_pipe).toInt();
                    proximo_pago_str = sub_payload.substring(second_pipe + 1);
                    pago_vencido = !subscription_active;
                    xSemaphoreGive(sharedVarsMutex);
                    if(DEBUG_MODE) Serial.println("[N0] Datos de suscripción actualizados.");
                }
            }
        }

        // --- Tarea 2: Procesar Calibración Remota ---
        if (doc["calibration"]["update_available"] == true) {
            if (DEBUG_MODE) Serial.println("[N0] ¡Nuevos datos de calibracion recibidos!");
            // (La función saveCalibration ya está protegida con su propio mutex)
            saveCalibration();
        }

        // --- Tarea 3: Procesar Comandos Remotos ---
        if (doc.containsKey("command") && doc["command"] != nullptr) {
            String command = doc["command"];
            if (command == "reboot") {
                if (DEBUG_MODE) Serial.println("[N0] Comando 'reboot' recibido. Reiniciando en 3s...");
                vTaskDelay(pdMS_TO_TICKS(3000)); // Usamos vTaskDelay en lugar de delay()
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
    
    // El chequeo de actualización de firmware (OTA) se mantiene separado
    //checkForHttpUpdate();
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
            httpUpdateClient.setConnectTimeout(30000); 
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

// --- Función Mejorada de Medición con Secuencia y Calidad ---
void measureAndStoreData() {
    emon1.calcVI(20, 2000);
    emon1.calcIrms(1480);
    emon2.calcIrms(1480);

    latest_vrms = emon1.Vrms;
    latest_power = emon1.realPower;
    latest_irms1 = emon1.Irms;
    latest_irms2 = emon2.Irms;
    latest_temp_cpu = temperatureRead();

    uint8_t quality = 0;
    if (isnan(latest_vrms) || isinf(latest_vrms) || isnan(latest_irms1) || isinf(latest_irms1)) {
        if (DEBUG_MODE) Serial.println("[N1] Lectura inválida, usando valores estimados.");
        latest_vrms = 220.0;
        latest_irms1 = 0.0;
        latest_irms2 = 0.0;
        quality = 1;
    }

    if (latest_vrms < 30.0) latest_vrms = 0.0;
    if (latest_irms1 < 0.05) latest_irms1 = 0.0;
    if (latest_irms2 < 0.05) latest_irms2 = 0.0;
    if (latest_vrms == 0.0 || latest_irms1 == 0.0) latest_power = 0.0;
    latest_leakage = abs(latest_irms1 - latest_irms2);

    MeasurementData dataToSend;
    dataToSend.sequence_number = ++global_sequence_number;
    dataToSend.timestamp = time_synced ? time(NULL) : (millis() / 1000);
    dataToSend.vrms = latest_vrms;
    dataToSend.irms1 = latest_irms1;
    dataToSend.irms2 = latest_irms2;
    dataToSend.power = latest_power;
    dataToSend.leakage = latest_leakage;
    dataToSend.temp_cpu = latest_temp_cpu;
    dataToSend.quality_flag = quality;

    if (xSemaphoreTake(bufferMetricsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        buffer_health.total_measurements_taken++;
        xSemaphoreGive(bufferMetricsMutex);
    }

    if (xQueueSend(dataQueue, &dataToSend, pdMS_TO_TICKS(50)) != pdTRUE) {
        if (DEBUG_MODE) Serial.println("[N1] Cola llena, guardando directamente en buffer.");
        writeToBuffer(dataToSend);
    }
}


// --- FUNCIONES DE INTERFAZ WEB (SERVIDOR) ---

// --> Página principal de la interfaz web, optimizada para evitar fragmentación de memoria
void handleRoot() {
    if (!server.authenticate(HTTP_USER, HTTP_PASS)) {
        return server.requestAuthentication();
    }

    // Iniciamos la transmisión sin conocer la longitud total
    server.setContentLength(CONTENT_LENGTH_UNKNOWN);
    server.send(200, "text/html", "");

    // Buffer para construir pequeños trozos de HTML de forma segura
    char chunk_buffer[512];

    // --- ENCABEZADO Y ESTILOS ---
    server.sendContent("<html><head><title>Monitor LETE</title>");
    server.sendContent("<meta http-equiv='refresh' content='5'>");
    server.sendContent("<meta name='viewport' content='width=device-width, initial-scale=1'>");
    server.sendContent("<style>body{font-family:sans-serif;} h2{color:#005b96;}</style></head><body>");

    // --- TÍTULO ---
    snprintf(chunk_buffer, sizeof(chunk_buffer), "<h1>Monitor LETE v%.1f</h1>", FIRMWARE_VERSION);
    server.sendContent(chunk_buffer);

    // --- SECCIÓN DE ESTADO PRINCIPAL ---
    server.sendContent("<h2>Estado Principal</h2>");
    snprintf(chunk_buffer, sizeof(chunk_buffer), "<p><b>Voltaje:</b> %.1f V</p>", latest_vrms);
    server.sendContent(chunk_buffer);
    snprintf(chunk_buffer, sizeof(chunk_buffer), "<p><b>Corriente:</b> %.2f A</p>", latest_irms1);
    server.sendContent(chunk_buffer);
    snprintf(chunk_buffer, sizeof(chunk_buffer), "<p><b>Potencia:</b> %.0f W</p>", latest_power);
    server.sendContent(chunk_buffer);
    snprintf(chunk_buffer, sizeof(chunk_buffer), "<p><b>Fuga:</b> %.3f A</p>", latest_leakage);
    server.sendContent(chunk_buffer);

    // --- SECCIÓN DE CONECTIVIDAD ---
    server.sendContent("<h2>Conectividad</h2>");
    snprintf(chunk_buffer, sizeof(chunk_buffer), "<p><b>Red:</b> %s (%d dBm)</p>", WiFi.SSID().c_str(), WiFi.RSSI());
    server.sendContent(chunk_buffer);
    snprintf(chunk_buffer, sizeof(chunk_buffer), "<p><b>IP:</b> %s</p>", WiFi.localIP().toString().c_str());
    server.sendContent(chunk_buffer);
    snprintf(chunk_buffer, sizeof(chunk_buffer), "<p><b>Nube:</b> %s</p>", (server_status ? "OK" : "Error"));
    server.sendContent(chunk_buffer);
    snprintf(chunk_buffer, sizeof(chunk_buffer), "<p><b>Suscripci&oacute;n:</b> %s</p>", (subscription_active ? "Activa" : "Inactiva"));
    server.sendContent(chunk_buffer);

    // --- SECCIÓN DE DIAGNÓSTICO DEL SISTEMA ---
    server.sendContent("<h2>Diagnostico del Sistema</h2>");
    long uptime_seconds = millis() / 1000;
    snprintf(chunk_buffer, sizeof(chunk_buffer), "<p><b>Uptime:</b> %ldd %ldh %ldm</p>", uptime_seconds / 86400, (uptime_seconds % 86400) / 3600, (uptime_seconds % 3600) / 60);
    server.sendContent(chunk_buffer);
    snprintf(chunk_buffer, sizeof(chunk_buffer), "<p><b>Memoria Libre:</b> %u KB</p>", ESP.getFreeHeap() / 1024);
    server.sendContent(chunk_buffer);
    snprintf(chunk_buffer, sizeof(chunk_buffer), "<p><b>Archivos en Buffer:</b> %d</p>", buffer_file_count);
    server.sendContent(chunk_buffer);

    // --- SECCIÓN DE ACCIONES ---
    server.sendContent("<h2>Acciones</h2>");
    server.sendContent("<p><a href='/calibracion'>Ajustar Calibracion</a></p>");
    server.sendContent("<p><a href='/update'>Buscar Actualizaciones de Firmware</a></p>");
    server.sendContent("<p><a href='/reset-wifi'>Borrar Credenciales Wi-Fi</a></p>");
    server.sendContent("<p><a href='/restart' onclick='return confirm(\"¿Estás seguro de que quieres reiniciar el dispositivo?\");'>Reiniciar Dispositivo</a></p>");
    server.sendContent("<p style='color:red;'><a href='/factory-reset' onclick='return confirm(\"¡ACCIÓN DESTRUCTIVA!\\n¿Estás SEGURO de que quieres borrar TODOS los datos y reiniciar?\");'>Reseteo de Fábrica</a></p>");

    // --- FINAL DE LA PÁGINA ---
    server.sendContent("</body></html>");
    // Finalizamos la transmisión enviando un chunk vacío
    server.sendContent("");
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
        // --> AÑADIDO v8.0: Validar que los argumentos existen
        if (server.hasArg("voltage") && server.hasArg("current1") && server.hasArg("current2")) {
            float new_voltage_cal = server.arg("voltage").toFloat();
            float new_current_cal_1 = server.arg("current1").toFloat();
            float new_current_cal_2 = server.arg("current2").toFloat();

            // --> AÑADIDO v8.0: Validar rangos razonables (ajusta según tu hardware)
            if (new_voltage_cal > 100.0 && new_voltage_cal < 300.0 &&
                new_current_cal_1 > 5.0 && new_current_cal_1 < 50.0 &&
                new_current_cal_2 > 5.0 && new_current_cal_2 < 50.0) {
                
                voltage_cal = new_voltage_cal;
                current_cal_1 = new_current_cal_1;
                current_cal_2 = new_current_cal_2;
                
                saveCalibration();
                server.send(200, "text/plain", "OK. Calibracion guardada.");
            } else {
                server.send(400, "text/plain", "Error: Valores de calibracion fuera de rango.");
            }
        } else {
            server.send(400, "text/plain", "Error: Faltan parametros.");
        }
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

// --> Borra todos los datos y reinicia (Wi-Fi y Calibración) de forma segura
void handleFactoryReset() {
    if (!server.authenticate(HTTP_USER, HTTP_PASS)) {
        return server.requestAuthentication();
    }

    if (DEBUG_MODE) Serial.println("Iniciando reseteo de fábrica...");

    // Tomamos el control de SPIFFS para borrar los archivos de forma segura.
    if (xSemaphoreTake(spiffsMutex, pdMS_TO_TICKS(5000)) == pdTRUE) { // Damos más tiempo para esta operación crítica
        // Borrar archivo de calibración
        if (SPIFFS.exists("/calibracion.json")) {
            SPIFFS.remove("/calibracion.json");
            if (DEBUG_MODE) Serial.println("Archivo de calibracion borrado.");
        }

        // Borrar todos los archivos del buffer en cola
        if (DEBUG_MODE) Serial.println("Borrando archivos de buffer...");
        for (int i = 0; i < MAX_BUFFER_FILES; i++) {
            String filename = "/buffer_" + String(i) + ".txt";
            if (SPIFFS.exists(filename)) {
                SPIFFS.remove(filename);
            }
        }
        
        // Liberamos el mutex antes de las operaciones de red y reinicio.
        xSemaphoreGive(spiffsMutex);
    } else {
        if (DEBUG_MODE) Serial.println("CRITICAL: Timeout al esperar el mutex en handleFactoryReset. Abortando borrado de archivos.");
        server.send(500, "text/html", "<h1>Error Crítico</h1><p>No se pudo acceder al sistema de archivos para el reseteo. Inténtelo de nuevo.</p>");
        return;
    }

    // Borrar credenciales de Wi-Fi (esto no toca SPIFFS)
    WiFiManager wm;
    wm.resetSettings();
    if (DEBUG_MODE) Serial.println("Credenciales Wi-Fi borradas.");

    server.send(200, "text/html", "<h1>Reseteo de Fábrica Completo</h1><p>El dispositivo se reiniciará en 2 segundos.</p>");
    delay(2000);
    ESP.restart();
}

// --- NUEVAS FUNCIONES DE UTILIDAD v8.2 ---

// --- Nueva Función para Envío en Lotes (Más Eficiente) ---
bool sendBatchToInflux(const MeasurementData* dataArray, int count) {
    if (count <= 0) return false;

    String batch_payload = "";
    batch_payload.reserve(count * 200);

    for (int i = 0; i < count; i++) {
        if (isnan(dataArray[i].vrms) || isinf(dataArray[i].vrms)) {
            if (DEBUG_MODE) Serial.printf("[N0] Saltando medición inválida %u en lote.\n", dataArray[i].sequence_number);
            continue;
        }

        char influx_line[400];
        snprintf(influx_line, sizeof(influx_line),
            "%s,device=LETE-%04X vrms=%.2f,irms1=%.3f,irms2=%.3f,power=%.2f,leakage=%.3f,cpu_temp=%.1f,quality=%u,seq=%u %llu",
            INFLUXDB_MEASUREMENT, (uint16_t)ESP.getEfuseMac(),
            dataArray[i].vrms, dataArray[i].irms1, dataArray[i].irms2, dataArray[i].power, dataArray[i].leakage, dataArray[i].temp_cpu,
            dataArray[i].quality_flag, dataArray[i].sequence_number, (unsigned long long)dataArray[i].timestamp);
        
        batch_payload += influx_line;
        if (i < count - 1) batch_payload += "\n";
    }

    if (batch_payload.isEmpty()) {
        if (DEBUG_MODE) Serial.println("[N0] Lote vacío después de validaciones.");
        return false;
    }
    
    HTTPClient http;
    http.setTimeout(CONNECTION_TIMEOUT_MS * 2);
    http.begin(INFLUXDB_URL);
    http.addHeader("Authorization", "Token " INFLUXDB_TOKEN);
    http.addHeader("Content-Type", "text/plain");
    
    int httpCode = http.POST(batch_payload);
    bool success = (httpCode >= 200 && httpCode < 300);
    http.end();
    
    if (success) {
        if (xSemaphoreTake(bufferMetricsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
            buffer_health.measurements_sent_live += count;
            xSemaphoreGive(bufferMetricsMutex);
        }
        if (DEBUG_MODE) Serial.printf("[N0] Lote de %d mediciones enviado exitosamente.\n", count);
    } else {
        for (int i = 0; i < count; i++) {
            writeToBuffer(dataArray[i]);
        }
        if (DEBUG_MODE) Serial.printf("[N0] Fallo lote (HTTP:%d), %d mediciones al buffer.\n", httpCode, count);
    }
    return success;
}

// --- Función de Compresión de Datos (Formato Compacto) ---
String compressDataPayload(const MeasurementData& data) {
    char compressed_buffer[200];
    int chars_written = snprintf(compressed_buffer, sizeof(compressed_buffer),
        "%u|%u|%.2f|%.3f|%.3f|%.2f|%.3f|%.1f|%u",
        data.sequence_number, data.timestamp, data.vrms, data.irms1, data.irms2,
        data.power, data.leakage, data.temp_cpu, data.quality_flag);
    
    if (chars_written < 0 || chars_written >= sizeof(compressed_buffer)) {
        if (DEBUG_MODE) Serial.println("Error en compresión de datos.");
        return "";
    }
    return String(compressed_buffer);
}

// --- Función de Descompresión (Para Lectura del Buffer) ---
MeasurementData decompressDataPayload(const String& compressed) {
    MeasurementData data = {0};
    int indices[9] = {0};
    int found = 0;
    int last_index = -1;

    for (int i = 0; i < compressed.length() && found < 8; i++) {
        if (compressed[i] == '|') {
            indices[found++] = i;
        }
    }

    if (found >= 7) {
        data.sequence_number = compressed.substring(0, indices[0]).toInt();
        data.timestamp = compressed.substring(indices[0] + 1, indices[1]).toInt();
        data.vrms = compressed.substring(indices[1] + 1, indices[2]).toFloat();
        data.irms1 = compressed.substring(indices[2] + 1, indices[3]).toFloat();
        data.irms2 = compressed.substring(indices[3] + 1, indices[4]).toFloat();
        data.power = compressed.substring(indices[4] + 1, indices[5]).toFloat();
        data.leakage = compressed.substring(indices[5] + 1, indices[6]).toFloat();
        data.temp_cpu = compressed.substring(indices[6] + 1, indices[7]).toFloat();
        if (found >= 8) {
             data.quality_flag = compressed.substring(indices[7] + 1).toInt();
        }
    }
    return data;
}

// --- Función de Rotación de Archivos del Buffer ---
void rotateBufferFiles() {
    if (DEBUG_MODE) Serial.println("[N0] Iniciando rotación de archivos de buffer...");
    uint32_t oldest_timestamp = UINT32_MAX;
    String oldest_file = "";

    for (int i = 0; i < MAX_BUFFER_FILES; i++) {
        String filename = "/buffer_" + String(i) + ".txt";
        if (SPIFFS.exists(filename)) {
            File file = SPIFFS.open(filename, FILE_READ);
            if (file && file.size() > 0) {
                String first_line = file.readStringUntil('\n');
                file.close();
                MeasurementData data = decompressDataPayload(first_line);
                if (data.timestamp < oldest_timestamp) {
                    oldest_timestamp = data.timestamp;
                    oldest_file = filename;
                }
            } else if (file) {
                file.close();
            }
        }
    }
    
    if (!oldest_file.isEmpty()) {
        SPIFFS.remove(oldest_file);
        if (DEBUG_MODE) Serial.printf("[N0] Archivo más antiguo eliminado: %s\n", oldest_file.c_str());
    }
}

// --- Nueva Función para Verificar Estabilidad de WiFi ---
bool isWifiConnectionStable() {
    if (WiFi.status() != WL_CONNECTED) {
        wifi_reconnect_attempts++;
        return false;
    }
    if (WiFi.RSSI() < -85) return false;
    wifi_reconnect_attempts = 0;
    return true;
}

// --- Función para Manejo de Recuperación de Red ---
void handleNetworkRecovery() {
    if (wifi_reconnect_attempts >= WIFI_RECONNECT_ATTEMPTS) {
        if (DEBUG_MODE) Serial.println("[N0] Demasiados fallos de WiFi. Reiniciando ESP32...");
        vTaskDelay(pdMS_TO_TICKS(2000));
        ESP.restart();
    }
    if (WiFi.status() != WL_CONNECTED) {
        if (DEBUG_MODE) Serial.println("[N0] Intentando reconexión WiFi...");
        WiFi.reconnect();
        vTaskDelay(pdMS_TO_TICKS(5000));
    }
}

// --- Función para Chequeo de Salud del Buffer ---
void checkBufferHealth() {
    if (xSemaphoreTake(bufferMetricsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        int current_files = countBufferFiles();
        buffer_health.buffer_usage_percent = (float)current_files / MAX_BUFFER_FILES * 100.0;
        
        if (DEBUG_MODE) {
            Serial.printf("\n[N0] --- SALUD DEL BUFFER ---\n");
            Serial.printf(" > Uso: %.1f%% (%d/%d archivos)\n", buffer_health.buffer_usage_percent, current_files, MAX_BUFFER_FILES);
            Serial.printf(" > Mediciones: %u tomadas, %u enviadas, %u en buffer, %u perdidas\n", buffer_health.total_measurements_taken, buffer_health.measurements_sent_live, buffer_health.measurements_buffered, buffer_health.measurements_lost);
            Serial.printf(" > Fallos de red: %u | Overflows: %u\n", buffer_health.network_failures, buffer_health.buffer_overflows);
            Serial.printf("---------------------------\n");
        }
        xSemaphoreGive(bufferMetricsMutex);
    }
}

// --- Función Mejorada para Contar Archivos de Buffer (con Cache) ---
int countBufferFiles() {
    static unsigned long last_count_time = 0;
    static int cached_count = 0;
    
    if (millis() - last_count_time < 5000) {
        return cached_count;
    }
    
    int count = 0;
    if (xSemaphoreTake(spiffsMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
        for (int i = 0; i < MAX_BUFFER_FILES; i++) {
            if (SPIFFS.exists("/buffer_" + String(i) + ".txt")) {
                count++;
            }
        }
        xSemaphoreGive(spiffsMutex);
        cached_count = count;
        last_count_time = millis();
    }
    return count;
}

// --- Nueva Página Web para Estadísticas del Buffer v8.2 ---
void handleBufferStats() {
    if (!server.authenticate(HTTP_USER, HTTP_PASS)) {
        return server.requestAuthentication();
    }

    // Obtener métricas actuales de forma segura
    BufferHealthMetrics current_metrics = {0};
    if (xSemaphoreTake(bufferMetricsMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
        current_metrics = buffer_health;
        xSemaphoreGive(bufferMetricsMutex);
    }

    server.setContentLength(CONTENT_LENGTH_UNKNOWN);
    server.send(200, "text/html", "");

    char chunk_buffer[512];

    // Encabezado
    server.sendContent("<html><head><title>Estadísticas del Buffer - LETE</title>");
    server.sendContent("<meta http-equiv='refresh' content='10'>");
    server.sendContent("<meta name='viewport' content='width=device-width, initial-scale=1'>");
    server.sendContent("<style>body{font-family:sans-serif;} .metric{background:#f0f0f0;padding:10px;margin:5px;border-radius:5px;} .alert{color:red;} .ok{color:green;}</style></head><body>");

    server.sendContent("<h1>Estadísticas del Buffer LETE v8.2</h1>");
    server.sendContent("<p><a href='/'>&larr; Volver al Panel Principal</a></p>");

    // Métricas principales
    server.sendContent("<h2>Métricas de Rendimiento</h2>");
    
    snprintf(chunk_buffer, sizeof(chunk_buffer), 
        "<div class='metric'><b>Mediciones Totales:</b> %u</div>", 
        current_metrics.total_measurements_taken);
    server.sendContent(chunk_buffer);
    
    snprintf(chunk_buffer, sizeof(chunk_buffer), 
        "<div class='metric'><b>Enviadas en Vivo:</b> %u</div>", 
        current_metrics.measurements_sent_live);
    server.sendContent(chunk_buffer);
    
    snprintf(chunk_buffer, sizeof(chunk_buffer), 
        "<div class='metric'><b>En Buffer:</b> %u</div>", 
        current_metrics.measurements_buffered);
    server.sendContent(chunk_buffer);
    
    snprintf(chunk_buffer, sizeof(chunk_buffer), 
        "<div class='metric'><b>Perdidas:</b> %u</div>", 
        current_metrics.measurements_lost);
    server.sendContent(chunk_buffer);

    // Estado del buffer
    server.sendContent("<h2>Estado del Buffer</h2>");
    
    String usage_class = (current_metrics.buffer_usage_percent > 80) ? "alert" : "ok";
    snprintf(chunk_buffer, sizeof(chunk_buffer), 
        "<div class='metric %s'><b>Uso del Buffer:</b> %.1f%%</div>", 
        usage_class.c_str(), current_metrics.buffer_usage_percent);
    server.sendContent(chunk_buffer);
    
    snprintf(chunk_buffer, sizeof(chunk_buffer), 
        "<div class='metric'><b>Archivos de Buffer:</b> %d / %d</div>", 
        countBufferFiles(), MAX_BUFFER_FILES);
    server.sendContent(chunk_buffer);
    
    snprintf(chunk_buffer, sizeof(chunk_buffer), 
        "<div class='metric'><b>Overflows del Buffer:</b> %u</div>", 
        current_metrics.buffer_overflows);
    server.sendContent(chunk_buffer);
    
    snprintf(chunk_buffer, sizeof(chunk_buffer), 
        "<div class='metric'><b>Fallos de Red:</b> %u</div>", 
        current_metrics.network_failures);
    server.sendContent(chunk_buffer);

    // Información de datos más antiguos
    if (current_metrics.oldest_buffered_timestamp > 0 && time_synced) {
        uint32_t age_seconds = time(NULL) - current_metrics.oldest_buffered_timestamp;
        snprintf(chunk_buffer, sizeof(chunk_buffer), 
            "<div class='metric'><b>Dato más Antiguo:</b> %u segundos</div>", 
            age_seconds);
        server.sendContent(chunk_buffer);
    }

    // Calcular tasas de éxito
    if (current_metrics.total_measurements_taken > 0) {
        float success_rate = (float)current_metrics.measurements_sent_live / current_metrics.total_measurements_taken * 100.0f;
        float loss_rate = (float)current_metrics.measurements_lost / current_metrics.total_measurements_taken * 100.0f;
        
        server.sendContent("<h2>Tasas de Rendimiento</h2>");
        
        String success_class = (success_rate > 90) ? "ok" : "alert";
        snprintf(chunk_buffer, sizeof(chunk_buffer), 
            "<div class='metric %s'><b>Tasa de Éxito:</b> %.1f%%</div>", 
            success_class.c_str(), success_rate);
        server.sendContent(chunk_buffer);
        
        snprintf(chunk_buffer, sizeof(chunk_buffer), 
            "<div class='metric'><b>Tasa de Pérdida:</b> %.1f%%</div>", 
            loss_rate);
        server.sendContent(chunk_buffer);
    }

    server.sendContent("</body></html>");
    server.sendContent("");
}

// --- FUNCIÓN DE SETUP (VERSIÓN FINAL Y PULIDA) ---
void setup() {
    Serial.begin(115200);
    pinMode(BUTTON_PIN, INPUT_PULLUP);
    Wire.begin(I2C_SDA, I2C_SCL);

    bootTime = millis();

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

    // --> AÑADIDO v8.0: Crear Mutex
    spiffsMutex = xSemaphoreCreateMutex();
    sharedVarsMutex = xSemaphoreCreateMutex();
    bufferMetricsMutex = xSemaphoreCreateMutex(); // Nuevo mutex

    if (spiffsMutex == NULL || sharedVarsMutex == NULL || bufferMetricsMutex == NULL) {
    Serial.println("Error crítico: Fallo creando mutex.");
    ESP.restart(); // Reiniciar si no se pueden crear
    }

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
    WiFi.begin("Bitavo_red_2.4Gnormal", "Pegaso18");
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
    server.on("/buffer-stats", handleBufferStats); // Nueva página
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
    dataQueue = xQueueCreate(MAX_QUEUE_SIZE, sizeof(MeasurementData));
    if (dataQueue != NULL) {
        xTaskCreatePinnedToCore(
             networkTask,        /* Function to implement the task */
             "Network Task v8.2",     /* Name of the task */
             20480,              /* Stack size in words --> AUMENTADO a 16KB */
             NULL,               /* Task input parameter */
             1,                  /* Priority of the task */
             NULL,               /* Task handle. */
             0);                 /* Core where the task should run */
           
    } else {
        if(DEBUG_MODE) Serial.println("Error critico: No se pudo crear la cola de datos.");
    }
}

// --- FUNCIÓN DE LOOP PRINCIPAL (VERSIÓN FINAL v8.1 PARA NÚCLEO 1) ---
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
            button_press_start_time = currentMillis;
            last_button_press = currentMillis;
            button_is_pressed = true;
        } else {
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
        if (button_is_pressed) {
            if (currentMillis - last_button_press < 2000) { 
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
    
    // 5. Lógica de Pantalla OLED (con lectura segura de variables compartidas)
    bool pago_vencido_local = false;
    if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        pago_vencido_local = pago_vencido;
        xSemaphoreGive(sharedVarsMutex);
    }
    
    buffer_file_count = countBufferFiles(); // Esta función ahora es segura
    
    if (OLED_CONECTADA) {
        unsigned long current_rotation_interval = (screen_mode == 0) ?
            SCREEN_CONSUMPTION_INTERVAL_MS : SCREEN_OTHER_INTERVAL_MS;
        
        if (currentMillis - last_screen_change_time > current_rotation_interval) {
            screen_mode = (screen_mode + 1) % 3;
            last_screen_change_time = currentMillis;
        }

        if (pago_vencido_local) {
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
    if (currentMillis - bootTime > DAILY_RESTART_INTERVAL_MS) {
        if (DEBUG_MODE) Serial.println("Reinicio diario programado. Reiniciando...");
        delay(1000);
        ESP.restart();
    }
}

// --- INCLUSIÓN DE ARCHIVOS SEPARADOS ---
#include "oled_screens.h"