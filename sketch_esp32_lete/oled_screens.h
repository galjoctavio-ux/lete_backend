// =========================================================================
// --- FUNCIONES DE PANTALLA OLED v15.0 (Con icono de Nube)
// =========================================================================

#pragma once

// --- Declaraciones de funciones ---
void setupOLED();
void drawGenericMessage(String line1, String line2);
void drawBootScreen(String status);
void drawUpdateScreen(String status, int percentage);
void drawConsumptionScreen();
const char* getWifiIcon(int rssi); 

// Inicializa la pantalla OLED
void setupOLED() {
    if (OLED_CONECTADA) {
        if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
            if (DEBUG_MODE) Serial.println(F("[ERROR] Fallo al iniciar SSD1306"));
            return;
        }
        display.clearDisplay();
        display.setTextColor(SSD1306_WHITE);
        display.cp437(true); // Habilitar set de caracteres con iconos
    }
}

// Dibuja un mensaje genérico de dos líneas (para Errores, WiFiManager, etc.)
void drawGenericMessage(String line1, String line2) {
    if (OLED_CONECTADA) {
        display.clearDisplay();
        display.setTextSize(2);
        display.setCursor(0, 10);
        if (line1.length() > 10) line1 = line1.substring(0, 10);
        display.println(line1);
        display.setTextSize(1);
        display.setCursor(0, 40);
        if (line2.length() > 21) line2 = line2.substring(0, 21);
        display.println(line2);
        display.display();
    }
}

// --- Pantalla de Arranque ---
void drawBootScreen(String status) {
    if (OLED_CONECTADA) {
        display.clearDisplay();
        
        display.setTextSize(2);
        display.setCursor(5, 15); 
        display.println("Cuentatron");
        
        display.setTextSize(1);
        display.setCursor(0, 50);
        if (status.length() > 21) status = status.substring(0, 21);
        display.print(status);

        display.display();
    }
}

// --- Pantalla de Actualización OTA con Barra de Progreso ---
void drawUpdateScreen(String status, int percentage) {
    if (OLED_CONECTADA) {
        display.clearDisplay();
        display.setTextSize(1);
        
        display.setCursor(0, 0);
        display.println("-- ACTUALIZANDO --");

        display.setCursor(0, 16);
        display.print(status);

        display.setCursor(0, 32);
        display.printf("%d%%", percentage);

        display.drawRect(0, 48, SCREEN_WIDTH, 10, SSD1306_WHITE); 
        int progressWidth = (percentage * (SCREEN_WIDTH - 4)) / 100;
        display.fillRect(2, 50, progressWidth, 6, SSD1306_WHITE); 
        
        display.display();
    }
}

// Devuelve el icono de WiFi según la potencia de la señal
const char* getWifiIcon(int rssi) {
    if (rssi == 0 || rssi < -85) return "\x11"; // Icono bajo o desconectado
    if (rssi > -70) return "\x1E"; // Icono lleno
    if (rssi > -80) return "\x1F"; // Icono medio
    return "\x11"; // Icono bajo por defecto
}

// Dibuja la pantalla principal de consumo (ÚNICA PANTALLA DE OPERACIÓN)
void drawConsumptionScreen() {
    if (!OLED_CONECTADA) return;
    
    // <-- CAMBIO: Desactivado este debug.
    // Se ejecuta cada 50ms e inunda el monitor serie,
    // dificultando la depuración de otras tareas.
    // if (DEBUG_MODE) Serial.println("[N1-Debug] Dibujando pantalla: Consumo");

    display.clearDisplay();

    float vrms, irms, power;
    bool nube_conectada = false; // <-- AÑADIDO: Variable local para el estado de la nube
 
    // Tomar el Mutex para leer de forma segura las variables compartidas
    if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
        vrms = latest_vrms;
        irms = latest_irms_phase;
        power = latest_power;
        nube_conectada = mqtt_connected_status; // <-- AÑADIDO: Leer la bandera de MQTT
        xSemaphoreGive(sharedVarsMutex);
    }
    
    float va = vrms * irms;
    float power_factor = (va > 0) ? (power / va) : 0;

    // Potencia en grande y centrada
    display.setTextSize(3);
    char power_str[10];
    sprintf(power_str, "%.0f", power);
    int16_t x1, y1;
    uint16_t w, h;
    display.getTextBounds(power_str, 0, 0, &x1, &y1, &w, &h);
    display.setCursor((SCREEN_WIDTH - w) / 2, 15);
    display.print(power_str);
    display.setTextSize(1);
    display.setCursor(display.getCursorX() + 5, 28);
    display.print("W");

    // Datos secundarios
    display.setCursor(0, 0);
    display.printf("V:%.1f", vrms);
    display.setCursor(70, 0);
    display.printf("A:%.2f", irms);
    
    // Fila inferior de estado
    display.setCursor(0, 56);
    display.printf("WiFi:%s", getWifiIcon(WiFi.RSSI()));
    
    display.setCursor(45, 56);
    display.print("Nube:");
    
    // <-- CAMBIO: Lógica para mostrar el icono de Nube (MQTT)
    if (nube_conectada) {
        display.print("\x10"); // Icono de "check" (tilde)
    } else {
        display.print("\x1D"); // Icono de "X" (cruz)
    }

    display.setCursor(90, 56);
    display.printf("FP:%.2f", power_factor);
    
    display.display();
}