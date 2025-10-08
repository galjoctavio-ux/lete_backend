// =========================================================================
// --- FUNCIONES DE PANTALLA OLED v10.0 (Revisión Final y Completa)
// =========================================================================

#pragma once

// --- Declaraciones de funciones para que el compilador las conozca ---
void setupOLED();
void drawGenericMessage(String line1, String line2);
void drawConsumptionScreen();
void drawDiagnosticsScreen();
void drawServiceScreen();
void drawPaymentDueScreen();
const char* getWifiIcon(int rssi); // Movida aquí para que esté declarada antes de su uso

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

// Dibuja un mensaje genérico de dos líneas
void drawGenericMessage(String line1, String line2) {
    if (OLED_CONECTADA) {
        display.clearDisplay();
        display.setTextSize(2);
        display.setCursor(0, 10);
        display.println(line1);
        display.setTextSize(1);
        display.setCursor(0, 40);
        display.println(line2);
        display.display();
    }
}

// Dibuja la pantalla de advertencia de pago
void drawPaymentDueScreen() {
    if (!OLED_CONECTADA) return;
    if (DEBUG_MODE) Serial.println("[N1-Debug] Dibujando pantalla: Pago Requerido");

    int dias_de_gracia;
    if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
        dias_de_gracia = dias_de_gracia_restantes;
        xSemaphoreGive(sharedVarsMutex);
    }

    display.clearDisplay();
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("-- PAGO REQUERIDO --");
    display.setCursor(0, 20);
    if (dias_de_gracia > 0) {
        display.printf("  Tu servicio expirara\n  en %d dia(s).\n\n", dias_de_gracia);
        display.println("  Realiza tu pago para\n  no perder tus datos.");
    } else {
        display.println("\n\n  Servicio suspendido.\n\n  Contacta a\n  Luz en tu Espacio.");
    }
    display.display();
}

// Devuelve el icono de WiFi según la potencia de la señal
const char* getWifiIcon(int rssi) {
    if (rssi == 0 || rssi < -85) return "\x11"; // Icono bajo o desconectado
    if (rssi > -70) return "\x1E"; // Icono lleno
    if (rssi > -80) return "\x1F"; // Icono medio
    return "\x11"; // Icono bajo por defecto
}

// Dibuja la pantalla principal de consumo
void drawConsumptionScreen() {
    if (!OLED_CONECTADA) return;
    if (DEBUG_MODE) Serial.println("[N1-Debug] Dibujando pantalla: Consumo");

    display.clearDisplay();

    float vrms, irms, power;
    bool s_status;
    if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
        vrms = latest_vrms;
        irms = latest_irms_phase;
        power = latest_power;
        s_status = server_status;
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
    display.printf(s_status ? "Nube:OK" : "Nube:--");
    // --- CAMBIO: Añadido Factor de Potencia ---
    display.setCursor(90, 56);
    display.printf("FP:%.2f", power_factor);
    
    display.display();
}

// Dibuja la pantalla de diagnóstico de red
void drawDiagnosticsScreen() {
    if (!OLED_CONECTADA) return;
    if (DEBUG_MODE) Serial.println("[N1-Debug] Dibujando pantalla: Diagnóstico");

    display.clearDisplay();
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("--- DIAGNOSTICO ---");
    
    display.setCursor(0, 12);
    String mac = WiFi.macAddress();
    mac.toUpperCase();
    mac.replace(":", "");
    display.printf("ID: LETE-%s\n", mac.substring(8).c_str());

    display.setCursor(0, 32);
    display.printf("Red: %s\n", WiFi.SSID().c_str());
    display.printf("IP: %s\n", WiFi.localIP().toString().c_str());
    display.printf("Senal: %d dBm", WiFi.RSSI());
    
    display.display();
}

// Dibuja la pantalla de estado del servicio/suscripción
void drawServiceScreen() {
    if (!OLED_CONECTADA) return;
    if (DEBUG_MODE) Serial.println("[N1-Debug] Dibujando pantalla: Servicio");

    bool sub_active;
    String next_payment;
    if (xSemaphoreTake(sharedVarsMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
        sub_active = subscription_active;
        next_payment = sub_next_payment_str;
        xSemaphoreGive(sharedVarsMutex);
    }

    display.clearDisplay();
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("--- MI SERVICIO ---");

    display.setCursor(0, 18);
    display.printf("Suscripcion: %s\n", sub_active ? "Activa" : "Inactiva");
    display.setCursor(0, 32);
    display.printf("Proximo Pago:\n %s\n", next_payment.c_str());
    
    display.setCursor(0, 52);
    display.printf("Firmware: v%.1f", FIRMWARE_VERSION);
    display.display();
}

