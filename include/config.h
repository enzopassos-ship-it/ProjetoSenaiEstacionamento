/*
 * ==========================================================================
 *  config.h - TODAS as configuracoes do projeto ficam aqui
 *  (rede Wi-Fi, pinos do ESP32, logica dos sinais e tempos)
 * ==========================================================================
 */
#pragma once
#include <Arduino.h>

// ============================== REDE WI-FI ===============================
#define WIFI_NOME    "Nicolas"
#define WIFI_SENHA   "Nicolasamor"

// Nome na rede local: o painel tambem abre em http://estacionamento.local
#define NOME_NA_REDE "estacionamento"

// Rede reserva: se a rede "Nicolas" nao conectar em AP_ATIVAR_APOS_MS, o
// proprio ESP32 cria esta rede Wi-Fi (painel em http://192.168.4.1).
// Enquanto ninguem estiver conectado na rede reserva, o ESP32 volta a
// procurar a rede "Nicolas" a cada INTERVALO_NOVA_TENTATIVA_MS.
#define AP_NOME                      "Estacionamento-ESP32"
#define AP_SENHA                     "senai1234"   // minimo de 8 caracteres
#define AP_ATIVAR_APOS_MS            20000UL
#define INTERVALO_NOVA_TENTATIVA_MS  30000UL

// =============================== FIREBASE ================================
// Realtime Database: o ESP32 envia o estado das vagas e o historico.
//   /estacionamento/estado     -> vagas, livres, ultima atualizacao
//   /estacionamento/historico  -> cada carro que entra/sai, reserva etc.
// So funciona conectado na rede "Nicolas" (precisa de internet).
#define FIREBASE_ATIVO         true
#define FIREBASE_URL           "https://estacionamento-senai-88d16-default-rtdb.firebaseio.com"
#define FIREBASE_INTERVALO_MS  20000UL   // reenvia o estado mesmo sem mudanca
                                         // (o painel usa isso para saber se o
                                         //  ESP32 esta ligado)

// ================================ PINOS ==================================
//  Placa: ESP32 DevKit V1 (ESP32-WROOM-32, 30 pinos)
//
//  Sensores: saida (coletor) do optoacoplador PC817 -> GPIO do ESP32
//  (pull-up interno ligado). Pinos escolhidos com pull-up interno e que
//  nao interferem no boot.
//
//  LEDs: GPIO -> resistor 220 ohm -> LED -> GND
//
//  Vaga 1
#define PINO_SENSOR_VAGA1     32   // D32
#define PINO_VERDE_VAGA1      23   // D23
#define PINO_VERMELHO_VAGA1   22   // D22
//  Vaga 2
#define PINO_SENSOR_VAGA2     33   // D33
#define PINO_VERDE_VAGA2      21   // D21
#define PINO_VERMELHO_VAGA2   19   // D19
//  Vaga 3
#define PINO_SENSOR_VAGA3     25   // D25
#define PINO_VERDE_VAGA3      18   // D18
#define PINO_VERMELHO_VAGA3    4   // D4

// LED azul da propria placa: indica o estado do Wi-Fi
//   piscando rapido = conectando | aceso = conectado | 2 piscadas = rede reserva
#define PINO_LED_STATUS        2

#define NUM_VAGAS 3

const uint8_t PINOS_SENSOR[NUM_VAGAS]   = { PINO_SENSOR_VAGA1,   PINO_SENSOR_VAGA2,   PINO_SENSOR_VAGA3 };
const uint8_t PINOS_VERDE[NUM_VAGAS]    = { PINO_VERDE_VAGA1,    PINO_VERDE_VAGA2,    PINO_VERDE_VAGA3 };
const uint8_t PINOS_VERMELHO[NUM_VAGAS] = { PINO_VERMELHO_VAGA1, PINO_VERMELHO_VAGA2, PINO_VERMELHO_VAGA3 };

// =========================== LOGICA DOS SINAIS ===========================
// Com o carrinho (ima) sobre a vaga, o MC-38 fecha o contato, acende o LED
// interno do optoacoplador e o transistor puxa o GPIO para GND (nivel LOW).
// Se na sua montagem a leitura ficar invertida, troque para false.
#define SENSOR_ATIVO_EM_LOW   false

// LEDs ligados como GPIO -> resistor -> LED -> GND acendem com HIGH.
#define LED_ATIVO_EM_HIGH     true

// ================================ TEMPOS =================================
#define TEMPO_DEBOUNCE_MS       250    // filtra trepidacao do reed switch
#define PISCA_RESERVA_MS        400    // LED vermelho piscando = vaga reservada
#define PASSO_TESTE_LEDS_MS     300    // velocidade do teste de LEDs
#define DURACAO_TESTE_LEDS_MS   3600   // duracao do teste de LEDs
#define MAX_EVENTOS             30     // tamanho do historico guardado

// Para testar sem sensores: digite 1, 2 ou 3 no Monitor Serial para
// simular um carro na vaga correspondente (digite de novo para tirar).
#define SIMULACAO_PELO_SERIAL   true

#define VERSAO_FIRMWARE "1.0.0"