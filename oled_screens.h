// =========================================================================
// --- 7. FUNCIONES DE PANTALLA OLED v7.0
// =========================================================================

#pragma once

void setupOLED() {
    if (OLED_CONECTADA) {
        delay(100); // --> MEJORA v7.0: Da tiempo al display para estabilizarse
        Wire.begin(I2C_SDA, I2C_SCL);
        if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
            if (DEBUG_MODE) Serial.println(F("Fallo al iniciar SSD1306"));
        }
        display.clearDisplay();
        display.setTextColor(SSD1306_WHITE);
        display.cp437(true); // Habilitar set de caracteres extendido para iconos
    }
}

// Pantallas genéricas
void drawConfigScreen(const char* apName) {
    if (OLED_CONECTADA) {
        display.clearDisplay();
        display.setTextSize(1);
        display.setCursor(0, 0);
        display.println("--- MODO CONFIGURACION ---");
        display.setCursor(0, 12);
        display.println("Conectate a la red:");
        display.setTextSize(2);
        display.setCursor(0, 25);
        display.println(apName);
        display.setTextSize(1);
        display.setCursor(0, 48);
        display.println("(192.168.4.1 en navegador)");
        display.display();
    }
}

void drawUpdateScreen(String text) {
    if (OLED_CONECTADA) {
        display.clearDisplay();
        display.setTextSize(1);
        display.setCursor(0, 0);
        display.println("--- ACTUALIZANDO ---");
        display.setTextSize(2);
        display.setCursor(10, 25);
        display.println(text);
        display.display();
    }
}

void drawGenericMessage(String line1, String line2) {
    if (OLED_CONECTADA) {
        display.clearDisplay();
        display.setTextSize(2);
        display.setCursor(0, 10);
        display.println(line1);
        display.setCursor(0, 40);
        display.setTextSize(1);
        display.println(line2);
        display.display();
    }
}

void drawPaymentDueScreen() {
    if (!OLED_CONECTADA) return;
    display.clearDisplay();
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("-- PAGO REQUERIDO --");
    display.setCursor(0, 20);
    if (dias_de_gracia_restantes > 0) {
        display.printf("  Tu servicio expirara\n  en %d dia(s).\n\n", dias_de_gracia_restantes);
        display.println("  Realiza tu pago para\n  no perder tus datos.");
    } else {
        display.println("\n\n  Servicio suspendido.\n\n  Contacta a\n  Luz en tu Espacio.");
    }
    display.display();
}

// --- NUEVAS PANTALLAS PRINCIPALES v7.0 ---

const char* getWifiIcon(int rssi) {
    if (rssi > -70) return "\x1E"; // Icono de WiFi lleno
    if (rssi > -80) return "\x1F"; // Icono de WiFi medio
    return "\x11"; // Icono de WiFi bajo
}

// Pantalla 1: La que el cliente quiere ver
void drawConsumptionScreen() {
    if (!OLED_CONECTADA) return;
    display.clearDisplay();

    // Foco principal: Potencia en Watts
    display.setTextSize(3);
    char power_str[10];
    sprintf(power_str, "%.0f", latest_power);
    int16_t x1, y1;
    uint16_t w, h;
    display.getTextBounds(power_str, 0, 0, &x1, &y1, &w, &h);
    display.setCursor((SCREEN_WIDTH - w) / 2, 15);
    display.print(power_str);

    display.setTextSize(1);
    display.setCursor(display.getCursorX() + 5, 28);
    display.print("W");

    // Información secundaria
    display.setCursor(0, 0);
    display.printf("V: %.1f", latest_vrms);
    display.setCursor(70, 0);
    display.printf("A: %.2f", latest_irms1);

    // Barra de estado inferior
    display.setCursor(0, 56);
    display.printf("WiFi:%s", getWifiIcon(WiFi.RSSI()));
    display.setCursor(45, 56);
    display.print(server_status ? "Nube:OK" : "Nube:--");
    if (buffer_file_count > 0) {
        display.setCursor(95, 56);
        display.printf("Cola:%d", buffer_file_count);
    }
    
    display.display();
}

// Pantalla 2: La que se usa para soporte técnico
void drawDiagnosticsScreen() {
    if (!OLED_CONECTADA) return;
    display.clearDisplay();
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("--- DIAGNOSTICO ---");
    
    display.setCursor(0, 12);
    display.println("ID Dispositivo:");
    String mac = WiFi.macAddress();
    mac.replace(":", "");
    display.println(mac);

    display.setCursor(0, 32);
    display.printf("Red: %s\n", WiFi.SSID().c_str());
    display.printf("Senal: %d dBm\n", WiFi.RSSI());
    display.printf("IP: %s\n", WiFi.localIP().toString().c_str());
    
    display.display();
}

// Pantalla 3: Información sobre la cuenta y versión
void drawServiceScreen() {
    if (!OLED_CONECTADA) return;
    display.clearDisplay();
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("--- MI SERVICIO ---");

    if (pago_vencido && dias_de_gracia_restantes > 0) {
        display.setTextSize(2);
        display.setCursor(0, 20);
        display.printf("EXPIRA EN\n  %d DIA(S)", dias_de_gracia_restantes);
        display.setTextSize(1);
    } else {
        display.setCursor(0, 15);
        display.printf("Suscripcion: %s\n", subscription_active ? "Activa" : "Inactiva");
        display.printf("Proximo Pago: %s\n", proximo_pago_str.c_str());
    }
    
    display.setCursor(0, 50);
    display.printf("Firmware: v%.1f", FIRMWARE_VERSION);
    display.display();
}