/* ==========================================================================
   Estacionamento inteligente - painel web
   --------------------------------------------------------------------------
   - Busca o estado das vagas no ESP32 (GET /api/estado) varias vezes por
     segundo e desenha a maquete 3D, a lista de vagas e o historico.
   - Envia comandos: reservar vaga, testar LEDs, zerar contadores.
   - Modo demonstracao: simula o ESP32 no navegador (abra com ?demo ou
     direto do computador, sem o ESP32).
   - Para abrir este arquivo no computador apontando para o ESP32:
       index.html?esp=192.168.0.50
   ========================================================================== */
(() => {
  'use strict';

  // ======================================================================
  //  CONFIGURACAO
  // ======================================================================
  const INTERVALO_BUSCA_MS = 700;      // painel aberto
  const INTERVALO_OCULTO_MS = 3000;    // aba em segundo plano
  const TEMPO_LIMITE_MS = 2500;        // espera maxima por resposta
  const FALHAS_PARA_OFFLINE = 3;

  // Firebase Realtime Database (o mesmo endereco do include/config.h)
  const FIREBASE_URL = 'https://estacionamento-senai-88d16-default-rtdb.firebaseio.com';
  const INTERVALO_FIREBASE_MS = 2000;
  const ESP_ONLINE_FIREBASE_MS = 60000;  // o ESP32 reenvia a cada 20 s

  const params = new URLSearchParams(location.search);
  const hostEsp = params.get('esp');
  const BASE = hostEsp ? `http://${hostEsp}` : '';
  // o ESP32 serve o painel em http na porta 80; Live Server, arquivo local
  // etc. nao tem a API do ESP32, entao nesses casos so o Firebase e usado
  const servidoPeloEsp = location.protocol === 'http:' && (location.port === '' || location.port === '80');
  const podeConectar = Boolean(hostEsp) || servidoPeloEsp;
  let modoDemo = params.has('demo');

  // carrinhos da maquete (estilo Hot Wheels): cor da lataria e da faixa
  const CARROS = [
    { cor: '#2F62D6', faixa: '#F4F6FA' },
    { cor: '#EE7A2A', faixa: '#1C1F24' },
    { cor: '#EEF0F2', faixa: '#2F62D6' },
  ];

  const VISTAS = {
    panoramica: { rx: 56, rz: -24 },
    cima: { rx: 0, rz: 0 },
    frente: { rx: 64, rz: 0 },
  };

  const TEXTO_EVENTO = {
    inicio: () => 'Sistema ligado',
    ocupada: (n) => `Carro estacionou na vaga ${n}`,
    liberada: (n) => `Carro saiu da vaga ${n}`,
    reservada: (n) => `Vaga ${n} reservada pelo painel`,
    reserva_cancelada: (n) => `Reserva da vaga ${n} cancelada`,
    zerado: () => 'Contadores zerados',
  };

  const COR = {
    livre: '#1FA55E',
    ocupada: '#D63A2C',
    reserva: '#EDB005',
    info: '#5AA9FF',
  };

  // ======================================================================
  //  ELEMENTOS
  // ======================================================================
  const $ = (id) => document.getElementById(id);
  const el = {
    indEsp: $('indEsp'),
    indEspTitulo: $('indEspTitulo'),
    indEspDetalhe: $('indEspDetalhe'),
    indFirebase: $('indFirebase'),
    indFirebaseTitulo: $('indFirebaseTitulo'),
    indFirebaseDetalhe: $('indFirebaseDetalhe'),
    sisFirebase: $('sisFirebase'),
    notaControle: $('notaControle'),
    avisoDemo: $('avisoDemo'),
    btnSairDemo: $('btnSairDemo'),
    palco: $('palco'),
    garagem: $('garagem'),
    letreiro: $('letreiro'),
    letreiroNumero: $('letreiroNumero'),
    letreiroTexto: $('letreiroTexto'),
    resumoOcupadas: $('resumoOcupadas'),
    resumoReservadas: $('resumoReservadas'),
    resumoEntradas: $('resumoEntradas'),
    resumoOcupacao: $('resumoOcupacao'),
    resumoBarra: $('resumoBarra'),
    resumoLivres: $('resumoLivres'),
    btnTema: $('btnTema'),
    listaVagas: $('listaVagas'),
    historico: $('historico'),
    sisRede: $('sisRede'),
    sisEndereco: $('sisEndereco'),
    sisSinal: $('sisSinal'),
    sisLigado: $('sisLigado'),
    sisFirmware: $('sisFirmware'),
    btnTestar: $('btnTestar'),
    btnZerar: $('btnZerar'),
    btnDemo: $('btnDemo'),
    toasts: $('toasts'),
  };

  // ======================================================================
  //  ESTADO
  // ======================================================================
  let estado = null;            // ultimo estado recebido do ESP32
  let offsetRelogio = 0;        // performance.now() - millis() do ESP32
  let ultimoEventoId = 0;
  let primeiraCarga = true;
  let falhas = 0;
  let timerBusca = null;

  // de onde vem os dados mostrados: 'esp' (rede local), 'nuvem' (Firebase), 'demo'
  let fonte = null;
  let espLocalOk = false;      // o ESP32 respondeu pela rede local
  let espTestado = !podeConectar; // ja tentou o ESP32 o suficiente para decidir
  const nuvem = {
    estado: undefined,         // undefined = ainda nao respondeu; null = banco vazio
    situacao: 'buscando',      // 'buscando' | 'ok' | 'erro'
    falhas: 0,
    historico: [],
    ultimoCarimbo: null,
    timer: null,
  };

  const podeControlar = () => modoDemo || fonte === 'esp';
  let testeAnimando = false;

  const espAgora = () => performance.now() - offsetRelogio;

  // ======================================================================
  //  MAQUETE 3D (CSS 3D, sem bibliotecas)
  // ======================================================================
  const cena = { vagas: [] };

  function criar(tag, classe, texto) {
    const n = document.createElement(tag);
    if (classe) n.className = classe;
    if (texto != null) n.textContent = texto;
    return n;
  }

  // plano deitado no chao da maquete
  function plano(classe, x, y, w, h, z, texto) {
    const p = criar('div', classe, texto);
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    if (w != null) p.style.width = `${w}px`;
    if (h != null) p.style.height = `${h}px`;
    p.style.transform = `translateZ(${z}px)`;
    return p;
  }

  // caixa 3D: (x, y) no chao, z = altura da base, w x d = area, h = altura
  function caixa({ x, y, z = 0, w, d, h, cor = '#888', classe = '' }) {
    const c = criar('div', `caixa ${classe}`.trim());
    c.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${d}px;transform:translateZ(${z}px);--cor:${cor}`;
    const faces = {
      topo: `left:0;top:0;width:${w}px;height:${d}px;transform:translateZ(${h}px)`,
      frente: `left:0;top:${d - h}px;width:${w}px;height:${h}px;transform-origin:50% 100%;transform:rotateX(-90deg)`,
      tras: `left:0;top:${-h}px;width:${w}px;height:${h}px;transform-origin:50% 100%;transform:rotateX(-90deg)`,
      esq: `left:${-h}px;top:0;width:${h}px;height:${d}px;transform-origin:100% 50%;transform:rotateY(90deg)`,
      dir: `left:${w}px;top:0;width:${h}px;height:${d}px;transform-origin:0 50%;transform:rotateY(-90deg)`,
    };
    for (const [nome, css] of Object.entries(faces)) {
      const f = criar('div', `face face-${nome}`);
      f.style.cssText = css;
      c.appendChild(f);
    }
    return c;
  }

  const face = (c, nome) => c.querySelector(`.face-${nome}`);

  function montarCarro(i, x, y) {
    const { cor, faixa } = CARROS[i % CARROS.length];
    const carro = criar('div', 'carro');
    carro.style.cssText = `left:${x}px;top:${y}px;width:116px;height:210px`;

    carro.appendChild(plano('sombra-carro', -12, -8, 140, 226, 0.5));

    for (const [rx, ry] of [[-5, 30], [109, 30], [-5, 148], [109, 148]]) {
      carro.appendChild(caixa({ x: rx, y: ry, z: 0, w: 12, d: 34, h: 15, classe: 'roda' }));
    }

    const corpo = caixa({ x: 0, y: 0, z: 6, w: 116, d: 210, h: 17, cor });
    face(corpo, 'topo').style.background =
      `linear-gradient(90deg, transparent 38%, ${faixa} 38% 45%, transparent 45% 55%, ${faixa} 55% 62%, transparent 62%), ${cor}`;
    const nariz = face(corpo, 'tras');
    const traseira = face(corpo, 'frente');
    for (const lado of ['left', 'right']) {
      const farol = criar('span', 'farol');
      farol.style[lado] = '12px';
      nariz.appendChild(farol);
      const lanterna = criar('span', 'lanterna');
      lanterna.style[lado] = '10px';
      traseira.appendChild(lanterna);
    }
    carro.appendChild(corpo);

    carro.appendChild(caixa({ x: 11, y: 58, z: 23, w: 94, d: 104, h: 13, classe: 'vidro' }));
    carro.appendChild(caixa({ x: 13, y: 66, z: 36, w: 90, d: 86, h: 3, cor }));
    return carro;
  }

  function montarCena(numVagas) {
    const g = el.garagem;
    g.textContent = '';
    cena.vagas = [];

    const X0 = 110;          // inicio da primeira vaga
    const LARG = 260;        // largura de cada vaga
    const Y0 = 44;           // fundo das vagas (apos a calcada)
    const PROF = 340;        // profundidade das vagas

    // base da maquete
    g.appendChild(caixa({ x: 0, y: 0, z: -20, w: 1000, d: 600, h: 20, classe: 'laje' }));
    g.appendChild(caixa({ x: 0, y: 0, z: 0, w: 1000, d: Y0, h: 6, cor: '#B9BEBC', classe: 'calcada' }));

    // canteiros laterais
    for (const cx of [16, 908]) {
      g.appendChild(caixa({ x: cx, y: 76, w: 76, d: 280, h: 12, cor: '#A9AEAC', classe: 'canteiro' }));
      for (const [bx, by, bh] of [[10, 18, 26], [30, 112, 34], [8, 200, 22]]) {
        g.appendChild(caixa({ x: cx + bx, y: 76 + by, z: 12, w: 40, d: 46, h: bh, cor: '#4E8A47' }));
      }
    }

    // placa do ESP32
    const esp = caixa({ x: 22, y: 8, z: 6, w: 70, d: 30, h: 8, classe: 'esp32' });
    const topoEsp = face(esp, 'topo');
    topoEsp.textContent = 'ESP32';
    topoEsp.appendChild(criar('span', 'esp32-led'));
    g.appendChild(esp);

    // faixas brancas entre as vagas
    for (let i = 0; i <= numVagas; i++) {
      g.appendChild(plano('faixa', X0 + i * LARG - 3, Y0, 6, PROF, 0.6));
    }

    // pista de circulacao
    g.appendChild(plano('linha-central', 30, 489, 940, 6, 0.6));
    g.appendChild(plano('seta', 300, 527, null, null, 0.6));
    g.appendChild(plano('seta', 640, 527, null, null, 0.6));
    g.appendChild(plano('texto-chao', 40, 533, null, null, 0.6, 'Entrada'));
    g.appendChild(plano('texto-chao', 890, 533, null, null, 0.6, 'Saída'));

    for (let i = 0; i < numVagas; i++) {
      const x = X0 + i * LARG;
      const cx = x + LARG / 2;

      const tinta = plano('tinta-vaga', x + 8, Y0 + 8, LARG - 16, PROF - 16, 0.4);
      const numero = plano('numero-vaga', cx - 60, 290, null, null, 0.7, String(i + 1));
      const sensor = plano('sensor', cx - 17, 167, null, null, 0.8);

      const poste = caixa({ x: cx - 25, y: 16, z: 6, w: 50, d: 14, h: 62, classe: 'poste' });
      const frente = face(poste, 'frente');
      const lampVerde = criar('span', 'lampada lampada-verde');
      const lampVermelha = criar('span', 'lampada lampada-vermelha');
      frente.append(lampVerde, lampVermelha);

      const carro = montarCarro(i, cx - 58, 70);

      g.append(tinta, numero, sensor, poste, carro);
      cena.vagas.push({ tinta, sensor, poste, carro, lampVerde, lampVermelha });
    }
  }

  // ---------------------------------------------------------- camera
  const vista = { ...VISTAS.panoramica };

  function aplicarVista(suave) {
    el.garagem.classList.toggle('suave', suave);
    el.garagem.style.setProperty('--rx', `${vista.rx}deg`);
    el.garagem.style.setProperty('--rz', `${vista.rz}deg`);
  }

  function marcarBotaoVista(nome) {
    document.querySelectorAll('[data-vista]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.vista === nome));
    });
  }

  document.querySelectorAll('[data-vista]').forEach((botao) => {
    botao.addEventListener('click', () => {
      Object.assign(vista, VISTAS[botao.dataset.vista]);
      aplicarVista(true);
      marcarBotaoVista(botao.dataset.vista);
    });
  });

  const limitar = (v, min, max) => Math.min(max, Math.max(min, v));
  let arrasto = null;

  el.palco.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    arrasto = { id: e.pointerId, x: e.clientX, y: e.clientY, rx: vista.rx, rz: vista.rz };
    el.palco.setPointerCapture(e.pointerId);
    el.palco.classList.add('arrastando');
  });
  el.palco.addEventListener('pointermove', (e) => {
    if (!arrasto || e.pointerId !== arrasto.id) return;
    const dx = e.clientX - arrasto.x;
    const dy = e.clientY - arrasto.y;
    if (Math.abs(dx) + Math.abs(dy) < 3) return;
    vista.rz = limitar(arrasto.rz - dx * 0.25, -75, 75);
    vista.rx = limitar(arrasto.rx - dy * 0.25, 0, 75);
    aplicarVista(false);
    marcarBotaoVista(null);
  });
  const fimArrasto = () => {
    arrasto = null;
    el.palco.classList.remove('arrastando');
  };
  el.palco.addEventListener('pointerup', fimArrasto);
  el.palco.addEventListener('pointercancel', fimArrasto);

  el.palco.addEventListener('keydown', (e) => {
    const passos = { ArrowLeft: [0, 8], ArrowRight: [0, -8], ArrowUp: [6, 0], ArrowDown: [-6, 0] };
    const p = passos[e.key];
    if (!p) return;
    e.preventDefault();
    vista.rx = limitar(vista.rx + p[0], 0, 75);
    vista.rz = limitar(vista.rz + p[1], -75, 75);
    aplicarVista(true);
    marcarBotaoVista(null);
  });

  function ajustarEscala() {
    const w = el.palco.clientWidth;
    const h = el.palco.clientHeight;
    const escala = Math.min(w / 1300, h / 760, 1.3);
    el.garagem.style.setProperty('--escala', escala.toFixed(3));
  }
  if ('ResizeObserver' in window) new ResizeObserver(ajustarEscala).observe(el.palco);
  window.addEventListener('resize', ajustarEscala);

  // ---------------------------------------------------- teste dos LEDs
  function animarTesteLeds() {
    if (testeAnimando) return;
    testeAnimando = true;
    el.garagem.classList.add('testando');
    const lampadas = [
      ...cena.vagas.map((v) => v.lampVerde),
      ...cena.vagas.map((v) => v.lampVermelha),
    ];
    let passo = 0;
    const total = lampadas.length * 2;   // duas voltas, igual ao ESP32
    const timer = setInterval(() => {
      lampadas.forEach((l) => l.classList.remove('aceso-teste'));
      if (passo >= total) {
        clearInterval(timer);
        el.garagem.classList.remove('testando');
        testeAnimando = false;
        return;
      }
      lampadas[passo % lampadas.length].classList.add('aceso-teste');
      passo++;
    }, 300);
  }

  // ======================================================================
  //  LISTA DE VAGAS
  // ======================================================================
  const linhas = [];

  function montarLista(numVagas) {
    el.listaVagas.textContent = '';
    linhas.length = 0;
    for (let i = 0; i < numVagas; i++) {
      const li = criar('li');
      const placa = criar('span', 'vaga-placa', String(i + 1));
      placa.setAttribute('aria-hidden', 'true');
      const info = criar('div');
      const nome = criar('p', 'vaga-estado', '–');
      const detalhe = criar('p', 'vaga-detalhe', '');
      info.append(nome, detalhe);
      const botao = criar('button', 'botao botao-linha botao-pequeno', 'Reservar');
      botao.type = 'button';
      botao.disabled = true;               // libera quando chegam os dados
      botao.addEventListener('click', () => alternarReserva(i + 1));
      li.append(placa, info, botao);
      el.listaVagas.appendChild(li);
      linhas.push({ li, nome, detalhe, botao });
    }
  }

  // ======================================================================
  //  FORMATACAO
  // ======================================================================
  function duracao(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return `${h} h ${String(m % 60).padStart(2, '0')} min`;
  }

  const ha = (ms) => (ms < 5000 ? 'agora mesmo' : `há ${duracao(ms)}`);
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

  function horaDoEvento(t) {
    const data = new Date(Date.now() - (espAgora() - t));
    return data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function estadoDaVaga(v) {
    if (v.ocupada) return 'ocupada';
    if (v.reservada) return 'reservada';
    return 'livre';
  }

  function qualidadeSinal(rssi) {
    if (rssi == null) return '–';
    const nome = rssi >= -60 ? 'Forte' : rssi >= -72 ? 'Bom' : 'Fraco';
    return `${nome} (${rssi} dBm)`;
  }

  // ======================================================================
  //  DESENHO
  // ======================================================================
  function aplicarEstado(novo) {
    if (!novo || !Array.isArray(novo.vagas)) return;

    // o ESP32 reiniciou (relogio voltou): recomeca sem avisos repetidos
    if (estado && novo.agora < estado.agora && !modoDemo) {
      ultimoEventoId = 0;
      primeiraCarga = true;
    }

    // _atrasoMs: dados do Firebase foram gerados um pouco antes de chegar
    offsetRelogio = performance.now() - novo.agora - (novo._atrasoMs || 0);

    if (cena.vagas.length !== novo.vagas.length) {
      montarCena(novo.vagas.length);
      montarLista(novo.vagas.length);
    }

    const eventosNovos = (novo.eventos || []).filter((e) => e.id > ultimoEventoId);
    estado = novo;

    desenharCena();
    desenharLetreiro();
    desenharLista();
    desenharHistorico(eventosNovos);
    desenharSistema();
    desenharResumo();

    if (!primeiraCarga) {
      for (const ev of eventosNovos) {
        if (ev.tipo === 'ocupada') toast(TEXTO_EVENTO.ocupada(ev.vaga), COR.ocupada);
        if (ev.tipo === 'liberada') toast(TEXTO_EVENTO.liberada(ev.vaga), COR.livre);
      }
    }
    if (eventosNovos.length) ultimoEventoId = Math.max(...eventosNovos.map((e) => e.id));

    if (novo.testeLeds && !testeAnimando && !primeiraCarga) animarTesteLeds();
    primeiraCarga = false;
  }

  function desenharCena() {
    estado.vagas.forEach((v, i) => {
      const s = estadoDaVaga(v);
      const c = cena.vagas[i];
      c.tinta.dataset.estado = s;
      c.poste.dataset.estado = s;
      c.carro.dataset.estado = v.ocupada ? 'ocupada' : 'livre';
      c.sensor.dataset.estado = v.ocupada ? 'ocupada' : 'livre';
    });
  }

  function desenharLetreiro() {
    const livres = estado.vagas.filter((v) => !v.ocupada && !v.reservada).length;
    el.letreiro.dataset.estado = livres === 0 ? 'lotado' : 'livre';
    el.letreiroNumero.textContent = String(livres);
    el.letreiroTexto.textContent = livres === 0 ? 'lotado' : livres === 1 ? 'vaga livre' : 'vagas livres';
  }

  function desenharLista() {
    const agora = espAgora();
    estado.vagas.forEach((v, i) => {
      const linha = linhas[i];
      const s = estadoDaVaga(v);
      const tempo = ha(agora - v.desde);
      linha.li.dataset.estado = s;

      const entradas = plural(v.entradas, 'entrada', 'entradas');
      if (s === 'ocupada') {
        linha.nome.textContent = 'Ocupada';
        linha.detalhe.textContent = `${tempo[0].toUpperCase()}${tempo.slice(1)}, ${entradas}`;
      } else if (s === 'reservada') {
        linha.nome.textContent = 'Reservada';
        linha.detalhe.textContent = `Esperando o carro, ${entradas}`;
      } else {
        linha.nome.textContent = 'Livre';
        linha.detalhe.textContent = `${tempo[0].toUpperCase()}${tempo.slice(1)}, ${entradas}`;
      }

      if (s === 'reservada') {
        linha.botao.textContent = 'Cancelar';
        linha.botao.disabled = false;
        linha.botao.title = '';
      } else {
        linha.botao.textContent = 'Reservar';
        linha.botao.disabled = s === 'ocupada';
        linha.botao.title = s === 'ocupada' ? 'A vaga está ocupada' : '';
      }
      if (!podeControlar()) {
        linha.botao.disabled = true;
        linha.botao.title = 'Disponível só com o painel aberto pelo endereço do ESP32';
      }
      linha.botao.setAttribute('aria-label',
        s === 'reservada' ? `Cancelar reserva da vaga ${i + 1}` : `Reservar vaga ${i + 1}`);
    });
  }

  function desenharHistorico(eventosNovos) {
    const eventos = (estado.eventos || []).slice().reverse();
    const idsNovos = new Set(primeiraCarga ? [] : eventosNovos.map((e) => e.id));
    el.historico.textContent = '';

    const visiveis = eventos.filter((e) => TEXTO_EVENTO[e.tipo]);
    for (const e of visiveis) el.historico.appendChild(itemHistorico(e, idsNovos.has(e.id)));
    if (!visiveis.some((e) => e.vaga > 0)) {
      el.historico.appendChild(
        criar('li', 'historico-vazio', 'Nenhum carro passou ainda. Coloque um carrinho em uma vaga para começar.'),
      );
    }
  }

  function itemHistorico(e, novo) {
    const li = criar('li', novo ? 'novo' : '');
    li.dataset.tipo = e.tipo;
    const ponto = criar('span', 'ponto');
    ponto.setAttribute('aria-hidden', 'true');
    const hora = criar('time', 'hora', horaDoEvento(e.t));
    li.append(ponto, hora, criar('span', '', TEXTO_EVENTO[e.tipo](e.vaga)));
    return li;
  }

  function desenharSistema() {
    const r = estado.rede || {};
    if (modoDemo) {
      el.sisRede.textContent = `${r.nome} (simulada)`;
    } else if (r.modo === 'reserva') {
      el.sisRede.textContent = `${r.nome} (rede reserva do ESP32)`;
    } else if (r.modo === 'conectando') {
      el.sisRede.textContent = `Procurando ${r.nome}`;
    } else {
      el.sisRede.textContent = r.nome || '–';
    }
    el.sisEndereco.textContent = r.ip && r.ip !== '0.0.0.0' ? `http://${r.ip}` : '–';
    if (r.mdns && r.modo !== 'conectando') el.sisEndereco.title = `Também em http://${r.mdns}`;
    el.sisSinal.textContent = r.modo === 'reserva' ? 'Rede própria' : qualidadeSinal(r.sinal);
    el.sisFirmware.textContent = estado.versao || '–';
    el.sisLigado.textContent = duracao(espAgora());

    // envio ao Firebase (informado pelo ESP32 ou calculado pela nuvem)
    const fb = estado.firebase;
    if (modoDemo) {
      el.sisFirebase.textContent = 'Pausado na demonstração';
    } else if (fonte === 'nuvem') {
      el.sisFirebase.textContent = `Último envio ${ha(espAgora() - estado.agora)}`;
    } else if (!fb || !fb.ativo) {
      el.sisFirebase.textContent = 'Desligado no config.h';
    } else if (fb.ok && fb.ultimoEnvio) {
      el.sisFirebase.textContent = `Último envio ${ha(espAgora() - fb.ultimoEnvio)}`;
    } else if (r.modo === 'reserva') {
      el.sisFirebase.textContent = 'Pausado: rede reserva sem internet';
    } else {
      el.sisFirebase.textContent = 'Ainda sem envio (verifique a internet)';
    }

    el.notaControle.hidden = podeControlar() || !estado;
    el.btnTestar.disabled = !podeControlar();
    el.btnZerar.disabled = !podeControlar();
  }

  function desenharResumo() {
    const vagas = estado.vagas;
    const decorrido = espAgora() - estado.agora;   // tempo desde a ultima leitura
    el.resumoOcupadas.textContent = String(vagas.filter((v) => v.ocupada).length);
    el.resumoReservadas.textContent = String(vagas.filter((v) => v.reservada).length);
    el.resumoEntradas.textContent = String(vagas.reduce((s, v) => s + v.entradas, 0));

    const base = vagas.length * (espAgora() - estado.inicioContagem);
    const ocupado = vagas.reduce((s, v) => s + v.ocupadoMs + (v.ocupada ? decorrido : 0), 0);
    const pct = base > 5000 ? Math.min(100, Math.round((ocupado / base) * 100)) : null;
    el.resumoOcupacao.textContent = pct == null ? '–' : `${pct}%`;
    if (el.resumoBarra) el.resumoBarra.style.width = `${pct || 0}%`;
    if (el.resumoLivres) {
      const livres = vagas.filter((v) => !v.ocupada && !v.reservada).length;
      el.resumoLivres.textContent = livres === 0 ? 'Lotado' : `${livres} ${livres === 1 ? 'livre' : 'livres'}`;
      el.resumoLivres.dataset.lotado = String(livres === 0);
    }
  }

  // atualiza tempos ("há 2 min") entre uma leitura e outra
  setInterval(() => {
    atualizarIndicadores();
    if (!estado) return;
    desenharLista();
    desenharSistema();
    desenharResumo();
  }, 1000);

  // ======================================================================
  //  INDICADORES DE CONEXAO (ESP32 e Firebase)
  //  laranja = buscando | verde = conectado | vermelho = sem conexao
  // ======================================================================
  function horaCurta(epochMs) {
    return new Date(epochMs).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  // o ESP32 esta mandando dados para o Firebase recentemente?
  function espOnlinePelaNuvem() {
    const e = nuvem.estado;
    return Boolean(e && e.atualizadoEm && Date.now() - e.atualizadoEm < ESP_ONLINE_FIREBASE_MS);
  }

  function definirIndicador(prefixo, situacao, titulo, detalhe) {
    const caixa = el[`ind${prefixo}`];
    caixa.dataset.estado = situacao;
    el[`ind${prefixo}Titulo`].textContent = titulo;
    el[`ind${prefixo}Detalhe`].textContent = detalhe;
  }

  let situacaoEspAnterior = 'buscando';

  function atualizarIndicadores() {
    if (modoDemo) {
      definirIndicador('Esp', 'demo', 'Demonstração', 'Dados simulados no navegador');
      definirIndicador('Firebase', 'pausado', 'Firebase pausado', 'Nada é enviado na demonstração');
      el.garagem.dataset.conexao = 'demo';
      return;
    }

    // ---- ESP32
    let sitEsp;
    if (espLocalOk) {
      sitEsp = 'ok';
      const ip = estado && estado.rede && estado.rede.ip;
      definirIndicador('Esp', 'ok', 'ESP32 conectado', ip ? `Pela rede local, em ${ip}` : 'Pela rede local');
    } else if (espOnlinePelaNuvem()) {
      sitEsp = 'ok';
      definirIndicador('Esp', 'ok', 'ESP32 conectado', 'Recebendo os dados pelo Firebase');
    } else if (!espTestado || nuvem.situacao === 'buscando') {
      sitEsp = 'buscando';
      definirIndicador('Esp', 'buscando', 'Buscando conexão com o ESP32', 'Aguarde alguns segundos');
    } else {
      sitEsp = 'erro';
      const ultimo = nuvem.estado && nuvem.estado.atualizadoEm;
      definirIndicador('Esp', 'erro', 'ESP32 desconectado',
        ultimo ? `Última notícia às ${horaCurta(ultimo)}` : 'Verifique se ele está ligado e no Wi-Fi');
    }
    if (sitEsp === 'erro' && situacaoEspAnterior === 'ok') {
      toast('O ESP32 parou de responder. Continuo tentando.', COR.ocupada);
    }
    if (sitEsp === 'ok' && situacaoEspAnterior !== 'ok') {
      toast('ESP32 conectado', COR.livre);
    }
    situacaoEspAnterior = sitEsp;
    el.garagem.dataset.conexao = sitEsp === 'ok' ? 'conectado' : sitEsp === 'buscando' ? 'conectando' : 'offline';

    // ---- Firebase
    if (nuvem.situacao === 'buscando') {
      definirIndicador('Firebase', 'buscando', 'Buscando conexão com o Firebase', 'Aguarde alguns segundos');
    } else if (nuvem.situacao === 'erro') {
      definirIndicador('Firebase', 'erro', 'Firebase sem resposta', 'Verifique a internet deste aparelho');
    } else if (!nuvem.estado) {
      definirIndicador('Firebase', 'ok', 'Firebase conectado', 'Aguardando o primeiro envio do ESP32');
    } else {
      const ha = Math.max(0, Date.now() - nuvem.estado.atualizadoEm);
      definirIndicador('Firebase', 'ok', 'Firebase conectado',
        `Dados atualizados às ${horaCurta(nuvem.estado.atualizadoEm)}${ha < 60000 ? '' : ' (ESP32 parado)'}`);
    }
  }

  // ======================================================================
  //  CONEXAO COM O ESP32 (rede local)
  // ======================================================================
  function trocarFonte(nova) {
    if (fonte === nova) return;
    fonte = nova;
    ultimoEventoId = 0;
    primeiraCarga = true;
    estado = null;
  }

  async function buscarEstado() {
    if (modoDemo || !podeConectar) return;
    const controle = new AbortController();
    const limite = setTimeout(() => controle.abort(), TEMPO_LIMITE_MS);
    try {
      const resposta = await fetch(`${BASE}/api/estado`, { cache: 'no-store', signal: controle.signal });
      if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
      const dados = await resposta.json();
      if (modoDemo) return;
      falhas = 0;
      espLocalOk = true;
      espTestado = true;
      trocarFonte('esp');
      aplicarEstado(dados);
    } catch (erro) {
      falhas++;
      if (falhas >= FALHAS_PARA_OFFLINE) {
        espTestado = true;
        if (espLocalOk) {
          espLocalOk = false;
          if (fonte === 'esp') fonte = null;   // deixa o Firebase assumir
        }
      }
    } finally {
      clearTimeout(limite);
      atualizarIndicadores();
      if (!modoDemo) {
        clearTimeout(timerBusca);
        timerBusca = setTimeout(buscarEstado, document.hidden ? INTERVALO_OCULTO_MS : INTERVALO_BUSCA_MS);
      }
    }
  }

  // ======================================================================
  //  CONEXAO COM O FIREBASE (Realtime Database, API REST)
  // ======================================================================
  async function buscarJson(url, limiteMs) {
    const controle = new AbortController();
    const limite = setTimeout(() => controle.abort(), limiteMs);
    try {
      const resposta = await fetch(url, { cache: 'no-store', signal: controle.signal });
      if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
      return await resposta.json();
    } finally {
      clearTimeout(limite);
    }
  }

  async function buscarHistoricoNuvem() {
    const url = `${FIREBASE_URL}/estacionamento/historico.json?orderBy=%22%24key%22&limitToLast=30`;
    const dados = await buscarJson(url, 5000);
    nuvem.historico = Object.values(dados || {})
      .filter((h) => h && typeof h.quando === 'number')
      .sort((a, b) => a.quando - b.quando);
  }

  // converte o formato do Firebase para o mesmo formato da API do ESP32
  function converterNuvem(e) {
    const ligado = e.ligadoMs || 0;
    const carimbo = e.atualizadoEm || Date.now();
    const chaves = Object.keys(e.vagas || {}).sort((a, b) => parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10));
    return {
      versao: e.firmware || '–',
      agora: ligado,
      _atrasoMs: Math.max(0, Date.now() - carimbo),
      inicioContagem: ligado - (e.contagemMs || 0),
      testeLeds: false,
      rede: { modo: 'nuvem', nome: e.rede || 'Nicolas', ip: e.ip || '', sinal: e.sinal ?? null, mdns: 'estacionamento.local' },
      vagas: chaves.map((k, i) => {
        const v = e.vagas[k] || {};
        return {
          id: i + 1,
          ocupada: Boolean(v.ocupada),
          reservada: Boolean(v.reservada),
          desde: ligado - (v.haMs || 0),
          entradas: v.entradas || 0,
          ocupadoMs: v.ocupadoMs || 0,
        };
      }),
      eventos: nuvem.historico.map((h) => ({
        id: h.quando,
        t: ligado - (carimbo - h.quando),
        vaga: h.vaga || 0,
        tipo: h.tipo,
      })),
    };
  }

  async function buscarFirebase() {
    if (modoDemo) return;
    try {
      const dados = await buscarJson(`${FIREBASE_URL}/estacionamento/estado.json`, 5000);
      nuvem.situacao = 'ok';
      nuvem.falhas = 0;
      nuvem.estado = dados;

      // sem o ESP32 na rede local, os dados mostrados vem do Firebase
      if (dados && dados.vagas && !espLocalOk && espTestado) {
        if (fonte !== 'nuvem' || dados.atualizadoEm !== nuvem.ultimoCarimbo) {
          await buscarHistoricoNuvem().catch(() => {});
          nuvem.ultimoCarimbo = dados.atualizadoEm;
        }
        trocarFonte('nuvem');
        aplicarEstado(converterNuvem(dados));
      }
    } catch (erro) {
      nuvem.falhas++;
      if (nuvem.falhas >= 2) nuvem.situacao = 'erro';
    } finally {
      atualizarIndicadores();
      if (!modoDemo) {
        clearTimeout(nuvem.timer);
        nuvem.timer = setTimeout(buscarFirebase, document.hidden ? 6000 : INTERVALO_FIREBASE_MS);
      }
    }
  }

  // envia um comando e devolve { ok, status, dados }
  async function enviarComando(caminho) {
    if (modoDemo) return demo.comando(caminho);
    try {
      const resposta = await fetch(`${BASE}${caminho}`, { method: 'POST' });
      const dados = await resposta.json().catch(() => null);
      if (resposta.ok && dados) aplicarEstado(dados);
      return { ok: resposta.ok, status: resposta.status, dados };
    } catch (erro) {
      return { ok: false, status: 0, dados: null };
    }
  }

  function mensagemDeErro(resultado) {
    if (resultado.status === 0) return 'Sem conexão com o ESP32. O comando não foi enviado.';
    if (resultado.status === 409) return 'Essa vaga está ocupada e não pode ser reservada.';
    return 'O ESP32 não aceitou o comando. Tente de novo.';
  }

  // ======================================================================
  //  ACOES DO PAINEL
  // ======================================================================
  async function alternarReserva(numero) {
    if (!estado) return;
    const vaga = estado.vagas[numero - 1];
    const reservar = !vaga.reservada;
    const r = await enviarComando(`/api/reservar?vaga=${numero}&valor=${reservar ? 1 : 0}`);
    if (!r.ok) {
      toast(mensagemDeErro(r), COR.ocupada);
      return;
    }
    toast(reservar ? `Vaga ${numero} reservada` : `Reserva da vaga ${numero} cancelada`, COR.reserva);
  }

  el.btnTestar.addEventListener('click', async () => {
    const r = await enviarComando('/api/testar-leds');
    if (!r.ok) {
      toast(mensagemDeErro(r), COR.ocupada);
      return;
    }
    animarTesteLeds();
    toast('Testando os LEDs da maquete', COR.info);
  });

  let timerZerar = null;
  function restaurarZerar() {
    clearTimeout(timerZerar);
    el.btnZerar.classList.remove('confirmando');
    el.btnZerar.textContent = 'Zerar contadores';
  }
  el.btnZerar.addEventListener('click', async () => {
    if (!el.btnZerar.classList.contains('confirmando')) {
      el.btnZerar.classList.add('confirmando');
      el.btnZerar.textContent = 'Confirmar: zerar tudo';
      timerZerar = setTimeout(restaurarZerar, 4000);
      return;
    }
    restaurarZerar();
    const r = await enviarComando('/api/zerar');
    toast(r.ok ? 'Contadores zerados' : mensagemDeErro(r), r.ok ? COR.info : COR.ocupada);
  });

  el.btnDemo.addEventListener('click', iniciarDemo);
  el.btnSairDemo.addEventListener('click', () => {
    const url = new URL(location.href);
    url.searchParams.delete('demo');
    location.href = url.toString();
  });

  // ======================================================================
  //  TOASTS
  // ======================================================================
  function toast(texto, cor) {
    const t = criar('div', 'toast', texto);
    if (cor) t.style.setProperty('--cor-toast', cor);
    el.toasts.appendChild(t);
    while (el.toasts.children.length > 4) el.toasts.firstChild.remove();
    setTimeout(() => {
      t.classList.add('saindo');
      setTimeout(() => t.remove(), 320);
    }, 3200);
  }

  // ======================================================================
  //  MODO DEMONSTRACAO (simula o ESP32 no navegador)
  // ======================================================================
  const demo = {
    t0: 0,
    seq: 0,
    vagas: [],
    eventos: [],
    inicioContagem: 0,
    testeAte: 0,
    timer: null,

    agora() { return Math.round(performance.now() - this.t0); },

    evento(vaga, tipo, t) {
      this.eventos.push({ id: ++this.seq, t: t ?? this.agora(), vaga, tipo });
      if (this.eventos.length > 30) this.eventos.shift();
    },

    iniciar() {
      this.t0 = performance.now() - 14 * 60 * 1000;   // "ligado" ha 14 min
      const a = this.agora();
      this.seq = 0;
      this.eventos = [];
      this.inicioContagem = 0;
      this.evento(0, 'inicio', 0);
      this.vagas = [
        { id: 1, ocupada: true, reservada: false, desde: a - 95000, entradas: 4, acumulado: 310000, trecho: a - 95000 },
        { id: 2, ocupada: false, reservada: false, desde: a - 41000, entradas: 3, acumulado: 220000, trecho: 0 },
        { id: 3, ocupada: false, reservada: true, desde: a - 30000, entradas: 2, acumulado: 150000, trecho: 0 },
      ];
      this.evento(2, 'ocupada', a - 260000);
      this.evento(1, 'liberada', a - 150000);
      this.evento(1, 'ocupada', a - 95000);
      this.evento(2, 'liberada', a - 41000);
      this.evento(3, 'reservada', a - 30000);
      this.publicar();
      this.agendar();
    },

    parar() { clearTimeout(this.timer); },

    estado() {
      const a = this.agora();
      return {
        versao: '1.0.0',
        agora: a,
        inicioContagem: this.inicioContagem,
        testeLeds: a < this.testeAte,
        rede: { modo: 'demo', nome: 'Nicolas', ip: '192.168.0.50', sinal: -58, mdns: 'estacionamento.local' },
        vagas: this.vagas.map((v) => ({
          id: v.id,
          ocupada: v.ocupada,
          reservada: v.reservada,
          desde: v.desde,
          entradas: v.entradas,
          ocupadoMs: v.acumulado + (v.ocupada ? a - v.trecho : 0),
        })),
        eventos: this.eventos.slice(),
      };
    },

    publicar() { aplicarEstado(this.estado()); },

    agendar() {
      this.timer = setTimeout(() => {
        this.passo();
        this.agendar();
      }, 5000 + Math.random() * 4000);
    },

    // um carro entra ou sai de uma vaga sorteada
    passo() {
      const a = this.agora();
      const v = this.vagas[Math.floor(Math.random() * this.vagas.length)];
      if (v.ocupada) {
        v.acumulado += a - v.trecho;
        v.ocupada = false;
        v.desde = a;
        this.evento(v.id, 'liberada');
      } else {
        if (v.reservada && Math.random() < 0.4) return;   // ainda esperando
        v.ocupada = true;
        v.reservada = false;
        v.desde = a;
        v.trecho = a;
        v.entradas++;
        this.evento(v.id, 'ocupada');
      }
      this.publicar();
    },

    comando(caminho) {
      const url = new URL(caminho, 'http://demo');
      const a = this.agora();
      if (url.pathname === '/api/reservar') {
        const n = Number(url.searchParams.get('vaga'));
        const reservar = url.searchParams.get('valor') !== '0';
        const v = this.vagas[n - 1];
        if (!v) return { ok: false, status: 400, dados: null };
        if (reservar) {
          if (v.ocupada) return { ok: false, status: 409, dados: null };
          if (!v.reservada) {
            v.reservada = true;
            v.desde = a;
            this.evento(n, 'reservada');
          }
        } else if (v.reservada) {
          v.reservada = false;
          v.desde = a;
          this.evento(n, 'reserva_cancelada');
        }
      } else if (url.pathname === '/api/testar-leds') {
        this.testeAte = a + 3600;
      } else if (url.pathname === '/api/zerar') {
        this.vagas.forEach((v) => { v.entradas = 0; v.acumulado = 0; v.trecho = a; });
        this.eventos = [];
        this.inicioContagem = a;
        this.evento(0, 'zerado');
      }
      const dados = this.estado();
      aplicarEstado(dados);
      return { ok: true, status: 200, dados };
    },
  };

  function iniciarDemo() {
    modoDemo = true;
    clearTimeout(timerBusca);
    clearTimeout(nuvem.timer);
    fonte = 'demo';
    estado = null;
    ultimoEventoId = 0;
    primeiraCarga = true;
    el.avisoDemo.hidden = false;
    el.btnDemo.hidden = true;
    atualizarIndicadores();
    demo.parar();
    demo.iniciar();
  }

  // ======================================================================
  //  TEMA CLARO / ESCURO
  // ======================================================================
  function aplicarTema(tema) {
    document.documentElement.dataset.tema = tema;
    el.btnTema.setAttribute('aria-pressed', String(tema === 'escuro'));
    el.btnTema.setAttribute('aria-label', tema === 'escuro' ? 'Usar tema claro' : 'Usar tema escuro');
    el.btnTema.title = el.btnTema.getAttribute('aria-label');
  }
  let temaSalvo = null;
  try { temaSalvo = localStorage.getItem('tema'); } catch (erro) { /* sem armazenamento */ }
  aplicarTema(temaSalvo || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro'));
  el.btnTema.addEventListener('click', () => {
    const novo = document.documentElement.dataset.tema === 'escuro' ? 'claro' : 'escuro';
    aplicarTema(novo);
    try { localStorage.setItem('tema', novo); } catch (erro) { /* sem armazenamento */ }
  });

  // ======================================================================
  //  INICIO
  // ======================================================================
  montarCena(3);
  montarLista(3);
  aplicarVista(false);
  ajustarEscala();
  requestAnimationFrame(() => el.garagem.classList.add('suave'));

  if (modoDemo) {
    iniciarDemo();
  } else {
    el.btnTestar.disabled = true;    // liberados quando o ESP32 responder
    el.btnZerar.disabled = true;
    atualizarIndicadores();          // comeca com as bolinhas laranjas
    buscarEstado();
    buscarFirebase();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !modoDemo) {
        clearTimeout(timerBusca);
        clearTimeout(nuvem.timer);
        buscarEstado();
        buscarFirebase();
      }
    });
  }
})();