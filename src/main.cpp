/*
 * ==========================================================================
 *  ESTACIONAMENTO INTELIGENTE - Projeto SENAI
 * --------------------------------------------------------------------------
 *  - Le 3 sensores magneticos MC-38 (um por vaga) atraves de optoacopladores
 *  - Acende LED verde (vaga livre) ou vermelho (vaga ocupada) em cada vaga
 *  - Conecta na rede Wi-Fi e serve o painel web (pasta data/) pelo LittleFS
 *  - API HTTP para o painel:
 *        GET  /api/estado                 -> estado das vagas + historico
 *        POST /api/reservar?vaga=N&valor=1 -> reserva (valor=0 cancela)
 *        POST /api/testar-leds            -> sequencia de teste dos LEDs
 *        POST /api/zerar                  -> zera contadores e historico
 *
 *  Configuracoes (Wi-Fi, pinos, tempos): include/config.h
 * ==========================================================================
 */
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <LittleFS.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

#include "config.h"

// ============================== ESTRUTURAS ===============================

struct Vaga {
  uint8_t  pinoSensor;
  uint8_t  pinoVerde;
  uint8_t  pinoVermelho;
  bool     ocupada;              // estado confirmado (apos o debounce)
  bool     reservada;            // reservada pelo painel
  bool     leituraAnterior;      // ultima leitura bruta do sensor
  uint32_t instanteLeitura;      // quando a leitura bruta mudou
  uint32_t desde;                // quando o estado confirmado mudou
  uint32_t entradas;             // quantos carros ja estacionaram
  uint32_t ocupadoAcumuladoMs;   // tempo total ocupada (desde o ultimo "zerar")
  uint32_t inicioTrechoOcupado;  // inicio da ocupacao atual
};

enum TipoEvento : uint8_t {
  EV_INICIO = 0,
  EV_OCUPADA,
  EV_LIBERADA,
  EV_RESERVADA,
  EV_RESERVA_CANCELADA,
  EV_ZERADO
};

const char* const NOMES_EVENTO[] = {
  "inicio", "ocupada", "liberada", "reservada", "reserva_cancelada", "zerado"
};

struct Evento {
  uint32_t id;
  uint32_t instante;   // millis() do momento do evento
  uint8_t  vaga;       // 1..NUM_VAGAS (0 = sistema)
  uint8_t  tipo;       // TipoEvento
};

enum EstadoRede : uint8_t {
  REDE_CONECTANDO = 0,   // procurando a rede "Nicolas"
  REDE_CONECTADA,        // conectado na rede "Nicolas"
  REDE_RESERVA           // rede propria do ESP32 (ponto de acesso)
};

// =============================== VARIAVEIS ===============================

Vaga     vagas[NUM_VAGAS];
Evento   eventos[MAX_EVENTOS];
uint8_t  qtdEventos      = 0;
uint8_t  proximoEvento   = 0;
uint32_t ultimoIdEvento  = 0;
uint32_t inicioContagem  = 0;      // inicio da contagem (ou do ultimo "zerar")

bool     testeLedsAtivo  = false;
uint32_t inicioTesteLeds = 0;

bool     simulacao[NUM_VAGAS] = { false };

EstadoRede estadoRede     = REDE_CONECTANDO;
uint32_t   inicioConexao  = 0;
uint32_t   ultimaTentativa = 0;
bool       mdnsAtivo      = false;
bool       sistemaArquivosOk = false;

WebServer servidor(80);

// Firebase: os envios rodam numa tarefa separada (nucleo 0), assim a
// leitura dos sensores e os LEDs nunca ficam esperando a internet.
volatile bool     firebasePendente   = true;   // estado mudou, precisa enviar
volatile bool     firebaseOk         = false;  // ultimo envio deu certo
volatile uint32_t firebaseUltimoEnvio = 0;     // millis() do ultimo envio ok
QueueHandle_t     filaFirebase       = nullptr; // eventos para o historico

// ================================ EVENTOS ================================

void registrarEvento(uint8_t vaga, TipoEvento tipo) {
  Evento& e  = eventos[proximoEvento];
  e.id       = ++ultimoIdEvento;
  e.instante = millis();
  e.vaga     = vaga;
  e.tipo     = tipo;
  proximoEvento = (proximoEvento + 1) % MAX_EVENTOS;
  if (qtdEventos < MAX_EVENTOS) qtdEventos++;

  firebasePendente = true;
  if (filaFirebase) xQueueSend(filaFirebase, &e, 0);
}

// ================================ SENSORES ===============================

// true = tem carro (ima) sobre a vaga
bool lerSensor(uint8_t i) {
  int  nivel = digitalRead(vagas[i].pinoSensor);
  bool ativo = SENSOR_ATIVO_EM_LOW ? (nivel == LOW) : (nivel == HIGH);
#if SIMULACAO_PELO_SERIAL
  ativo = ativo || simulacao[i];
#endif
  return ativo;
}

void inicializarVagas() {
  uint32_t agora = millis();
  for (uint8_t i = 0; i < NUM_VAGAS; i++) {
    Vaga& v = vagas[i];
    v.pinoSensor   = PINOS_SENSOR[i];
    v.pinoVerde    = PINOS_VERDE[i];
    v.pinoVermelho = PINOS_VERMELHO[i];

    pinMode(v.pinoSensor, INPUT_PULLUP);
    pinMode(v.pinoVerde, OUTPUT);
    pinMode(v.pinoVermelho, OUTPUT);
  }
  delay(20);   // tempo para o pull-up estabilizar

  for (uint8_t i = 0; i < NUM_VAGAS; i++) {
    Vaga& v = vagas[i];
    bool leitura           = lerSensor(i);
    v.ocupada              = leitura;
    v.reservada            = false;
    v.leituraAnterior      = leitura;
    v.instanteLeitura      = agora;
    v.desde                = agora;
    v.entradas             = 0;
    v.ocupadoAcumuladoMs   = 0;
    v.inicioTrechoOcupado  = agora;
    Serial.printf("[VAGA %u] estado inicial: %s\n", (unsigned)(i + 1),
                  leitura ? "OCUPADA" : "LIVRE");
  }
}

// Le os sensores com filtro (debounce): a mudanca so vale se a leitura
// ficar estavel por TEMPO_DEBOUNCE_MS.
void lerSensores() {
  uint32_t agora = millis();
  for (uint8_t i = 0; i < NUM_VAGAS; i++) {
    Vaga& v = vagas[i];
    bool leitura = lerSensor(i);

    if (leitura != v.leituraAnterior) {
      v.leituraAnterior = leitura;
      v.instanteLeitura = agora;
    }

    if (leitura == v.ocupada) continue;
    if (agora - v.instanteLeitura < TEMPO_DEBOUNCE_MS) continue;

    v.ocupada = leitura;
    v.desde   = agora;

    if (leitura) {
      v.entradas++;
      v.inicioTrechoOcupado = agora;
      v.reservada = false;               // o carro chegou: a reserva foi usada
      registrarEvento(i + 1, EV_OCUPADA);
      Serial.printf("[VAGA %u] OCUPADA  (entradas: %u)\n", (unsigned)(i + 1),
                    (unsigned)v.entradas);
    } else {
      v.ocupadoAcumuladoMs += agora - v.inicioTrechoOcupado;
      registrarEvento(i + 1, EV_LIBERADA);
      Serial.printf("[VAGA %u] LIVRE\n", (unsigned)(i + 1));
    }
  }
}

// ================================= LEDS ==================================

void escreverLed(uint8_t pino, bool aceso) {
  digitalWrite(pino, (aceso == LED_ATIVO_EM_HIGH) ? HIGH : LOW);
}

// Livre     -> verde aceso
// Ocupada   -> vermelho aceso
// Reservada -> vermelho piscando
void atualizarLeds() {
  uint32_t agora = millis();

  if (testeLedsAtivo) {
    uint32_t t = agora - inicioTesteLeds;
    if (t < DURACAO_TESTE_LEDS_MS) {
      // acende um LED por vez: verdes 1-2-3, depois vermelhos 1-2-3
      uint8_t passo = (t / PASSO_TESTE_LEDS_MS) % (NUM_VAGAS * 2);
      for (uint8_t i = 0; i < NUM_VAGAS; i++) {
        escreverLed(vagas[i].pinoVerde,    passo == i);
        escreverLed(vagas[i].pinoVermelho, passo == NUM_VAGAS + i);
      }
      return;
    }
    testeLedsAtivo = false;
    Serial.println("[LEDS] Teste concluido");
  }

  bool piscaLigado = ((agora / PISCA_RESERVA_MS) % 2) == 0;
  for (uint8_t i = 0; i < NUM_VAGAS; i++) {
    const Vaga& v = vagas[i];
    bool verde    = !v.ocupada && !v.reservada;
    bool vermelho = v.ocupada || (v.reservada && piscaLigado);
    escreverLed(v.pinoVerde, verde);
    escreverLed(v.pinoVermelho, vermelho);
  }
}

void atualizarLedStatus() {
  uint32_t t = millis();
  bool aceso = false;
  switch (estadoRede) {
    case REDE_CONECTADA:
      aceso = true;
      break;
    case REDE_CONECTANDO:
      aceso = ((t / 125) % 2) == 0;
      break;
    case REDE_RESERVA: {
      uint32_t f = t % 1500;
      aceso = (f < 120) || (f >= 300 && f < 420);
      break;
    }
  }
  digitalWrite(PINO_LED_STATUS, aceso ? HIGH : LOW);
}

// ================================ WI-FI ==================================

void iniciarMdns() {
  if (mdnsAtivo) return;
  if (MDNS.begin(NOME_NA_REDE)) {
    MDNS.addService("http", "tcp", 80);
    mdnsAtivo = true;
    Serial.printf("[MDNS] Painel tambem em http://%s.local\n", NOME_NA_REDE);
  }
}

void tentarConectar() {
  WiFi.disconnect();
  WiFi.begin(WIFI_NOME, WIFI_SENHA);
  ultimaTentativa = millis();
}

void iniciarWiFi() {
  WiFi.persistent(false);
  WiFi.setHostname(NOME_NA_REDE);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);            // respostas mais rapidas no painel
  WiFi.setAutoReconnect(false);    // as novas tentativas sao feitas abaixo
  WiFi.begin(WIFI_NOME, WIFI_SENHA);
  inicioConexao   = millis();
  ultimaTentativa = inicioConexao;
  estadoRede      = REDE_CONECTANDO;
  Serial.printf("[WIFI] Conectando na rede \"%s\"...\n", WIFI_NOME);
}

void iniciarRedeReserva() {
  WiFi.disconnect();
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_NOME, AP_SENHA);
  estadoRede      = REDE_RESERVA;
  ultimaTentativa = millis();
  Serial.printf("[WIFI] Rede \"%s\" nao encontrada.\n", WIFI_NOME);
  Serial.printf("[WIFI] Rede reserva criada: \"%s\" (senha: %s)\n", AP_NOME, AP_SENHA);
  Serial.printf("[WIFI] Painel em http://%s\n", WiFi.softAPIP().toString().c_str());
  iniciarMdns();
}

void gerenciarWiFi() {
  uint32_t agora     = millis();
  bool     conectado = (WiFi.status() == WL_CONNECTED);

  if (conectado && estadoRede != REDE_CONECTADA) {
    if (estadoRede == REDE_RESERVA) {
      WiFi.softAPdisconnect(true);
      Serial.println("[WIFI] Rede reserva desligada");
    }
    estadoRede = REDE_CONECTADA;
    Serial.printf("[WIFI] Conectado! Sinal: %d dBm\n", (int)WiFi.RSSI());
    Serial.println("==============================================");
    Serial.printf ("  PAINEL: http://%s\n", WiFi.localIP().toString().c_str());
    Serial.println("==============================================");
    iniciarMdns();
    return;
  }

  switch (estadoRede) {
    case REDE_CONECTADA:
      if (!conectado) {
        Serial.println("[WIFI] Conexao perdida, reconectando...");
        estadoRede    = REDE_CONECTANDO;
        inicioConexao = agora;
        tentarConectar();
      }
      break;

    case REDE_CONECTANDO:
      if (agora - inicioConexao >= AP_ATIVAR_APOS_MS) {
        iniciarRedeReserva();
      } else if (agora - ultimaTentativa >= 10000UL) {
        tentarConectar();
      }
      break;

    case REDE_RESERVA:
      // so procura a rede principal se ninguem estiver usando a reserva
      if (WiFi.softAPgetStationNum() == 0 &&
          agora - ultimaTentativa >= INTERVALO_NOVA_TENTATIVA_MS) {
        Serial.printf("[WIFI] Procurando a rede \"%s\" de novo...\n", WIFI_NOME);
        tentarConectar();
      }
      break;
  }
}

// =============================== FIREBASE ================================
// Usa a API REST do Realtime Database (sem biblioteca extra).
// {".sv":"timestamp"} faz o proprio Firebase gravar a data/hora atual.

bool firebaseEnviar(const char* metodo, const char* caminho, const String& corpo) {
  WiFiClientSecure cliente;
  cliente.setInsecure();            // maquete: nao valida o certificado
  HTTPClient http;
  http.setTimeout(6000);
  String url = String(FIREBASE_URL) + caminho + ".json";
  if (!http.begin(cliente, url)) return false;
  http.addHeader("Content-Type", "application/json");
  int codigo = http.sendRequest(metodo, corpo);
  http.end();
  if (codigo != 200) {
    Serial.printf("[FIREBASE] Falha ao enviar %s (codigo %d)\n", caminho, codigo);
  }
  return codigo == 200;
}

// Os tempos vao em "ms atras" (haMs) porque o ESP32 nao tem relogio de
// data/hora; o painel calcula o horario usando "atualizadoEm" do Firebase.
String montarEstadoFirebase() {
  uint32_t agora  = millis();
  uint8_t  livres = 0;
  String j;
  j.reserve(700);
  j += "{\"vagas\":{";
  for (uint8_t i = 0; i < NUM_VAGAS; i++) {
    const Vaga& v = vagas[i];
    uint32_t ocupadoMs = v.ocupadoAcumuladoMs;
    if (v.ocupada) ocupadoMs += agora - v.inicioTrechoOcupado;
    if (!v.ocupada && !v.reservada) livres++;
    if (i) j += ',';
    j += "\"vaga"; j += (unsigned)(i + 1); j += "\":{";
    j += "\"situacao\":\"";
    j += v.ocupada ? "ocupada" : (v.reservada ? "reservada" : "livre");
    j += "\",\"ocupada\":";   j += v.ocupada ? "true" : "false";
    j += ",\"reservada\":";   j += v.reservada ? "true" : "false";
    j += ",\"entradas\":";    j += (unsigned long)v.entradas;
    j += ",\"haMs\":";        j += (unsigned long)(agora - v.desde);
    j += ",\"ocupadoMs\":";   j += (unsigned long)ocupadoMs;
    j += '}';
  }
  j += "},\"livres\":";        j += (unsigned)livres;
  j += ",\"totalVagas\":";     j += (unsigned)NUM_VAGAS;
  j += ",\"ligadoMs\":";       j += (unsigned long)agora;
  j += ",\"contagemMs\":";     j += (unsigned long)(agora - inicioContagem);
  j += ",\"rede\":\"" WIFI_NOME "\"";
  j += ",\"ip\":\"";           j += WiFi.localIP().toString(); j += '"';
  j += ",\"sinal\":";          j += (int)WiFi.RSSI();
  j += ",\"firmware\":\"" VERSAO_FIRMWARE "\"";
  j += ",\"atualizadoEm\":{\".sv\":\"timestamp\"}}";
  return j;
}

void tarefaFirebase(void*) {
  uint32_t ultimoEnvio = 0;
  for (;;) {
    if (WiFi.status() == WL_CONNECTED && estadoRede == REDE_CONECTADA) {
      // 1) historico: um registro novo para cada evento
      Evento e;
      while (xQueuePeek(filaFirebase, &e, 0) == pdTRUE) {
        String corpo = String("{\"vaga\":") + (unsigned)e.vaga +
                       ",\"tipo\":\"" + NOMES_EVENTO[e.tipo] +
                       "\",\"quando\":{\".sv\":\"timestamp\"}}";
        if (!firebaseEnviar("POST", "/estacionamento/historico", corpo)) break;
        xQueueReceive(filaFirebase, &e, 0);   // so tira da fila se enviou
      }

      // 2) estado atual das vagas (quando muda ou a cada intervalo)
      uint32_t agora = millis();
      if (firebasePendente || agora - ultimoEnvio >= FIREBASE_INTERVALO_MS) {
        firebasePendente = false;
        bool ok = firebaseEnviar("PUT", "/estacionamento/estado", montarEstadoFirebase());
        if (ok) {
          if (!firebaseOk) Serial.println("[FIREBASE] Sincronizado com o Realtime Database");
          firebaseUltimoEnvio = millis();
        } else {
          firebasePendente = true;            // tenta de novo
        }
        firebaseOk  = ok;
        ultimoEnvio = agora;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(250));
  }
}

void iniciarFirebase() {
#if FIREBASE_ATIVO
  filaFirebase = xQueueCreate(20, sizeof(Evento));
  xTaskCreatePinnedToCore(tarefaFirebase, "firebase", 10240, nullptr, 1, nullptr, 0);
  Serial.printf("[FIREBASE] Enviando para %s\n", FIREBASE_URL);
#endif
}

// =============================== JSON / API ==============================

String textoJson(const String& texto) {
  String s;
  s.reserve(texto.length() + 2);
  s += '"';
  for (size_t i = 0; i < texto.length(); i++) {
    char c = texto[i];
    if (c == '"' || c == '\\') { s += '\\'; s += c; }
    else if ((uint8_t)c < 0x20) { s += ' '; }
    else { s += c; }
  }
  s += '"';
  return s;
}

String montarEstadoJson() {
  uint32_t agora = millis();
  String j;
  j.reserve(3200);

  j += "{\"versao\":\"" VERSAO_FIRMWARE "\"";
  j += ",\"agora\":";           j += (unsigned long)agora;
  j += ",\"inicioContagem\":";  j += (unsigned long)inicioContagem;
  j += ",\"testeLeds\":";       j += testeLedsAtivo ? "true" : "false";

  // ---- rede
  j += ",\"rede\":{\"modo\":\"";
  if (estadoRede == REDE_CONECTADA)      j += "estacao";
  else if (estadoRede == REDE_RESERVA)   j += "reserva";
  else                                   j += "conectando";
  j += "\",\"nome\":";
  if (estadoRede == REDE_RESERVA) {
    j += textoJson(AP_NOME);
    j += ",\"ip\":";   j += textoJson(WiFi.softAPIP().toString());
    j += ",\"sinal\":null";
  } else {
    j += textoJson(WIFI_NOME);
    j += ",\"ip\":";   j += textoJson(WiFi.localIP().toString());
    j += ",\"sinal\":";
    if (estadoRede == REDE_CONECTADA) j += (int)WiFi.RSSI();
    else                              j += "null";
  }
  j += ",\"mdns\":";   j += textoJson(String(NOME_NA_REDE) + ".local");
  j += "}";

  // ---- firebase
  j += ",\"firebase\":{\"ativo\":";  j += FIREBASE_ATIVO ? "true" : "false";
  j += ",\"ok\":";                   j += firebaseOk ? "true" : "false";
  j += ",\"ultimoEnvio\":";          j += (unsigned long)firebaseUltimoEnvio;
  j += "}";

  // ---- vagas
  j += ",\"vagas\":[";
  for (uint8_t i = 0; i < NUM_VAGAS; i++) {
    const Vaga& v = vagas[i];
    uint32_t ocupadoMs = v.ocupadoAcumuladoMs;
    if (v.ocupada) ocupadoMs += agora - v.inicioTrechoOcupado;

    if (i) j += ',';
    j += "{\"id\":";          j += (unsigned)(i + 1);
    j += ",\"ocupada\":";     j += v.ocupada   ? "true" : "false";
    j += ",\"reservada\":";   j += v.reservada ? "true" : "false";
    j += ",\"desde\":";       j += (unsigned long)v.desde;
    j += ",\"entradas\":";    j += (unsigned long)v.entradas;
    j += ",\"ocupadoMs\":";   j += (unsigned long)ocupadoMs;
    j += '}';
  }
  j += ']';

  // ---- historico (do mais antigo para o mais novo)
  j += ",\"eventos\":[";
  uint8_t inicio = (proximoEvento + MAX_EVENTOS - qtdEventos) % MAX_EVENTOS;
  for (uint8_t k = 0; k < qtdEventos; k++) {
    const Evento& e = eventos[(inicio + k) % MAX_EVENTOS];
    if (k) j += ',';
    j += "{\"id\":";     j += (unsigned long)e.id;
    j += ",\"t\":";      j += (unsigned long)e.instante;
    j += ",\"vaga\":";   j += (unsigned)e.vaga;
    j += ",\"tipo\":\""; j += NOMES_EVENTO[e.tipo]; j += '"';
    j += '}';
  }
  j += "]}";
  return j;
}

void enviarJson(int codigo, const String& corpo) {
  servidor.sendHeader("Access-Control-Allow-Origin", "*");
  servidor.sendHeader("Cache-Control", "no-store");
  servidor.send(codigo, "application/json; charset=utf-8", corpo);
}

void enviarErro(int codigo, const char* mensagem) {
  enviarJson(codigo, String("{\"ok\":false,\"erro\":") + textoJson(mensagem) + "}");
}

void rotaEstado() {
  enviarJson(200, montarEstadoJson());
}

void rotaReservar() {
  int  numero = servidor.arg("vaga").toInt();
  bool valor  = !servidor.hasArg("valor") || servidor.arg("valor") != "0";

  if (numero < 1 || numero > NUM_VAGAS) {
    enviarErro(400, "Vaga invalida");
    return;
  }

  Vaga& v = vagas[numero - 1];
  if (valor) {
    if (v.ocupada) {
      enviarErro(409, "A vaga esta ocupada");
      return;
    }
    if (!v.reservada) {
      v.reservada = true;
      registrarEvento(numero, EV_RESERVADA);
      Serial.printf("[PAINEL] Vaga %u reservada\n", (unsigned)numero);
    }
  } else if (v.reservada) {
    v.reservada = false;
    registrarEvento(numero, EV_RESERVA_CANCELADA);
    Serial.printf("[PAINEL] Reserva da vaga %u cancelada\n", (unsigned)numero);
  }
  enviarJson(200, montarEstadoJson());
}

void rotaTestarLeds() {
  testeLedsAtivo  = true;
  inicioTesteLeds = millis();
  Serial.println("[PAINEL] Teste de LEDs");
  enviarJson(200, montarEstadoJson());
}

void zerarContadores() {
  uint32_t agora = millis();
  for (uint8_t i = 0; i < NUM_VAGAS; i++) {
    vagas[i].entradas            = 0;
    vagas[i].ocupadoAcumuladoMs  = 0;
    vagas[i].inicioTrechoOcupado = agora;
  }
  qtdEventos     = 0;
  proximoEvento  = 0;
  inicioContagem = agora;
  registrarEvento(0, EV_ZERADO);
  Serial.println("[PAINEL] Contadores zerados");
}

void rotaZerar() {
  zerarContadores();
  enviarJson(200, montarEstadoJson());
}

// ============================ ARQUIVOS (PAINEL) ==========================

String tipoDoArquivo(const String& caminho) {
  if (caminho.endsWith(".html")) return "text/html; charset=utf-8";
  if (caminho.endsWith(".css"))  return "text/css; charset=utf-8";
  if (caminho.endsWith(".js"))   return "application/javascript; charset=utf-8";
  if (caminho.endsWith(".json")) return "application/json";
  if (caminho.endsWith(".svg"))  return "image/svg+xml";
  if (caminho.endsWith(".png"))  return "image/png";
  if (caminho.endsWith(".ico"))  return "image/x-icon";
  return "text/plain";
}

bool servirArquivo(String caminho) {
  if (!sistemaArquivosOk) return false;
  if (caminho.endsWith("/")) caminho += "index.html";
  if (!LittleFS.exists(caminho)) return false;

  File arquivo = LittleFS.open(caminho, "r");
  if (!arquivo) return false;
  servidor.sendHeader("Cache-Control", "no-cache");
  servidor.streamFile(arquivo, tipoDoArquivo(caminho));
  arquivo.close();
  return true;
}

// Pagina mostrada se o painel ainda nao foi gravado no LittleFS
const char PAGINA_SEM_PAINEL[] PROGMEM = R"HTML(<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Estacionamento - ESP32</title>
<style>body{font-family:system-ui,sans-serif;background:#0b1020;color:#e6e9f2;
max-width:560px;margin:40px auto;padding:0 20px;line-height:1.5}
code{background:#1b2340;padding:2px 6px;border-radius:4px}
.v{display:flex;gap:10px;margin:16px 0}.v div{flex:1;padding:14px;border-radius:10px;
text-align:center;font-weight:600;background:#1b2340}.l{color:#4ade80}.o{color:#f87171}</style>
</head><body><h2>O ESP32 esta funcionando</h2>
<p>Mas o painel ainda nao foi gravado. No VS Code, na aba do PlatformIO,
clique em <code>Upload Filesystem Image</code> e recarregue esta pagina.</p>
<div class="v" id="v"></div>
<script>async function a(){try{const r=await fetch('/api/estado');const e=await r.json();
document.getElementById('v').innerHTML=e.vagas.map(v=>'<div class="'+(v.ocupada?'o':'l')+
'">Vaga '+v.id+'<br>'+(v.ocupada?'OCUPADA':'LIVRE')+'</div>').join('')}catch(x){}}
a();setInterval(a,1000)</script></body></html>)HTML";

void rotaNaoEncontrada() {
  if (servidor.method() == HTTP_OPTIONS) {
    servidor.sendHeader("Access-Control-Allow-Origin", "*");
    servidor.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    servidor.send(204);
    return;
  }
  if (servirArquivo(servidor.uri())) return;

  if (servidor.uri() == "/" || servidor.uri() == "/index.html") {
    servidor.send_P(200, "text/html; charset=utf-8", PAGINA_SEM_PAINEL);
    return;
  }
  if (servidor.uri() == "/favicon.ico") {
    servidor.send(204);
    return;
  }
  servidor.send(404, "text/plain", "Nao encontrado");
}

void iniciarServidor() {
  servidor.on("/api/estado",      HTTP_GET,  rotaEstado);
  servidor.on("/api/reservar",    HTTP_POST, rotaReservar);
  servidor.on("/api/testar-leds", HTTP_POST, rotaTestarLeds);
  servidor.on("/api/zerar",       HTTP_POST, rotaZerar);
  servidor.onNotFound(rotaNaoEncontrada);
  servidor.begin();
  Serial.println("[WEB] Servidor iniciado na porta 80");
}

// ============================ MONITOR SERIAL =============================

void mostrarAjuda() {
  Serial.println("[AJUDA] Comandos do Monitor Serial:");
#if SIMULACAO_PELO_SERIAL
  Serial.println("        1, 2, 3 -> simula carro na vaga (de novo para tirar)");
#endif
  Serial.println("        i       -> mostra rede e estado das vagas");
  Serial.println("        t       -> testa os LEDs");
}

void mostrarInfo() {
  if (estadoRede == REDE_CONECTADA)
    Serial.printf("[INFO] Rede \"%s\" | painel: http://%s\n", WIFI_NOME,
                  WiFi.localIP().toString().c_str());
  else if (estadoRede == REDE_RESERVA)
    Serial.printf("[INFO] Rede reserva \"%s\" | painel: http://%s\n", AP_NOME,
                  WiFi.softAPIP().toString().c_str());
  else
    Serial.printf("[INFO] Conectando na rede \"%s\"...\n", WIFI_NOME);

#if FIREBASE_ATIVO
  Serial.printf("[INFO] Firebase: %s\n", firebaseOk ? "sincronizado" : "sem envio ainda");
#endif
  for (uint8_t i = 0; i < NUM_VAGAS; i++) {
    Serial.printf("[INFO] Vaga %u: %s%s | entradas: %u\n", (unsigned)(i + 1),
                  vagas[i].ocupada ? "OCUPADA" : "LIVRE",
                  vagas[i].reservada ? " (reservada)" : "",
                  (unsigned)vagas[i].entradas);
  }
}

void lerSerial() {
  while (Serial.available()) {
    char ch = Serial.read();
#if SIMULACAO_PELO_SERIAL
    if (ch >= '1' && ch < '1' + NUM_VAGAS) {
      uint8_t i = ch - '1';
      simulacao[i] = !simulacao[i];
      Serial.printf("[SIMULACAO] Vaga %u: carro %s\n", (unsigned)(i + 1),
                    simulacao[i] ? "colocado" : "retirado");
      continue;
    }
#endif
    if (ch == 'i' || ch == 'I') mostrarInfo();
    else if (ch == 't' || ch == 'T') { testeLedsAtivo = true; inicioTesteLeds = millis(); }
    else if (ch == '?' || ch == 'h' || ch == 'H') mostrarAjuda();
  }
}

// ============================== SETUP / LOOP =============================

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("==============================================");
  Serial.println("  ESTACIONAMENTO INTELIGENTE - Projeto SENAI");
  Serial.printf ("  Firmware %s\n", VERSAO_FIRMWARE);
  Serial.println("==============================================");

  pinMode(PINO_LED_STATUS, OUTPUT);
  inicializarVagas();
  atualizarLeds();                       // os LEDs funcionam mesmo sem Wi-Fi

  iniciarFirebase();                     // antes do primeiro evento

  inicioContagem = millis();
  registrarEvento(0, EV_INICIO);

  sistemaArquivosOk = LittleFS.begin(true);
  if (!sistemaArquivosOk) {
    Serial.println("[ARQUIVOS] Falha ao montar o LittleFS");
  } else if (!LittleFS.exists("/index.html")) {
    Serial.println("[ARQUIVOS] Painel nao encontrado: rode 'Upload Filesystem Image'");
  } else {
    Serial.println("[ARQUIVOS] Painel encontrado no LittleFS");
  }

  iniciarWiFi();
  iniciarServidor();
  mostrarAjuda();
}

void loop() {
  lerSerial();
  lerSensores();
  atualizarLeds();
  atualizarLedStatus();
  gerenciarWiFi();
  servidor.handleClient();
  delay(2);
}