// Verifica se algum canal de YouTube ou Twitch da lista esta transmitindo AO VIVO agora.
// Roda via GitHub Actions. O workflow principal (check-live.yml) e disparado a cada
// ~15 min (agendador externo + cron) e cuida da Twitch; o YouTube e checado por esse
// mesmo script, mas com um limitador interno de cota (ver "CONTROLE DE COTA" abaixo).
//
// Usa as APIs oficiais (YOUTUBE_API_KEY, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET,
// guardadas como secrets do GitHub Actions -- nunca aparecem no codigo nem no site).
//
// HISTORICO
// - Raspagem de HTML do YouTube: bloqueada em IPs de datacenter (LOGIN_REQUIRED).
// - 23/07/2026: feed RSS publico passou a dar 404/500 de forma inconsistente.
// - 22/08/2026: uploads playlist + videos.list nunca detecta live EM ANDAMENTO (ela so
//   entra na playlist depois de encerrar). Trocado por search.list eventType=live.
// - 09/10/2026 (revisao): o cron do GitHub rodava so 3-4x/dia em vez das 11 planejadas
//   (buracos de ate ~9h sem checar), e um erro de API em UM canal era tratado como
//   "offline" (apagava o status em vez de manter o ultimo). Agora:
//   1) o YouTube e checado pelo workflow de 15 em 15 min, mas o proprio script limita
//      a frequencia pra caber na cota (intervalo minimo, compartilhado entre workflows);
//   2) erro de API em um canal mantem o ultimo estado conhecido DAQUELE canal;
//   3) lives ja marcadas como ao vivo sao reconferidas a cada execucao por 1 unidade
//      de cota (videos.list) pra sumirem logo depois de acabar.
//
// CONTROLE DE COTA (limite gratuito: 10.000 unidades/dia)
// search.list custa 100 unidades por canal. Com 9 canais = 900 por checagem completa.
// Intervalo minimo de 150 min => no maximo 9,6 checagens/dia => ~8.640 unidades/dia,
// sobrando folga pra execucoes manuais (FORCE_YOUTUBE=1) e pra reconferencia (1 un.).
// O momento da ultima tentativa fica em canais_live.json (youtubeCheckedAt), entao o
// limite vale mesmo com varios workflows/execucoes concorrentes.
//
// Variaveis de ambiente opcionais:
//   SKIP_YOUTUBE=1 / SKIP_TWITCH=1  -> pula a plataforma nessa execucao (mantem estado).
//   FORCE_YOUTUBE=1                 -> ignora o intervalo minimo (execucao manual).
//   YT_MIN_INTERVAL_MIN=150         -> altera o intervalo minimo (minutos).

const fs = require('fs');

const API_KEY = process.env.YOUTUBE_API_KEY;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

const YT_MIN_INTERVAL_MIN = Number(process.env.YT_MIN_INTERVAL_MIN) > 0
  ? Number(process.env.YT_MIN_INTERVAL_MIN)
  : 150;

const CANAIS_TWITCH = [
  { id: 13, n: 'PELEHZADA', login: 'pelehzada' },
  { id: 14, n: 'tofogames10', login: 'tofogames10' },
  { id: 15, n: 'corvofps', login: 'corvofps' },
  { id: 16, n: 'gianzao', login: 'gianzao' },
  { id: 17, n: 'joaodobife', login: 'joaodobife' },
  { id: 19, n: 'cowboynanoo', login: 'cowboynanoo' },
];

// Mesmos ids/nomes do array "canais" no index.html -- mantenha em sincronia
// ao adicionar/remover canais de YouTube na aba Vendedores/Lives/Leiloes.
// channelId (UC...) resolvido uma vez via API (channels.list?forHandle=) e
// fixado aqui pra nao gastar cota resolvendo handle -> id toda hora.
const CANAIS_YOUTUBE = [
  { id: 1, n: 'Diego Sheth', channelId: 'UC6ZRxYOOJw2rwtuIerO-lrA' },
  { id: 2, n: 'Antec.r', channelId: 'UCWX9kXOO4awp-c3VeJtObPw' },
  { id: 3, n: 'Garimpo dos Games', channelId: 'UCkDTuzfIG3s_Z-JSoHw3IZQ' },
  { id: 4, n: 'Cara de Barata', channelId: 'UCefKgYBOrc3yff2gkhgslcQ' },
  { id: 5, n: 'DJ Games Retro', channelId: 'UC1yok96pYoUNtNnyN7zzWPQ' },
  { id: 7, n: 'Sigchap', channelId: 'UCpTyn0RRvTmjgNi7YYzUstA' },
  { id: 9, n: 'Rodrigo Retro Games', channelId: 'UChKgfyQRLATKl7dl-z6tolg' },
  { id: 12, n: 'VG Invest', channelId: 'UCEHV0ePP26xJVcPEoCLxfSQ' },
  { id: 18, n: 'Gilson Barbosa', channelId: 'UCZD4UEQy5SIvTo5eVQ3Ea7Q' },
];

// Le o canais_live.json atual (rede de seguranca): estado anterior das lives e o
// horario da ultima tentativa de checagem completa do YouTube.
function lerEstadoAnterior() {
  try {
    const data = JSON.parse(fs.readFileSync('canais_live.json', 'utf8'));
    return {
      live: Array.isArray(data.live) ? data.live : [],
      youtubeCheckedAt: typeof data.youtubeCheckedAt === 'string' ? data.youtubeCheckedAt : null,
    };
  } catch (e) {
    return { live: [], youtubeCheckedAt: null };
  }
}

function deveChecarYoutube(youtubeCheckedAt) {
  if (process.env.FORCE_YOUTUBE === '1') return true;
  if (!youtubeCheckedAt) return true;
  const t = Date.parse(youtubeCheckedAt);
  if (!Number.isFinite(t)) return true;
  const minutos = (Date.now() - t) / 60000;
  // minutos < 0 (relogio/estado estranho) -> checa, melhor do que travar pra sempre.
  return minutos < 0 || minutos >= YT_MIN_INTERVAL_MIN - 1; // -1 min de tolerancia de jitter
}

// Retorna { ok: true, item } (item = live ou null se offline) ou { ok: false, quota }.
async function checarLiveDoCanalYoutube(canal) {
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${canal.channelId}&eventType=live&type=video&key=${API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      const motivo = (data.error.errors && data.error.errors[0] && data.error.errors[0].reason) || '';
      console.warn(`Aviso: search.list falhou pra ${canal.n}: ${data.error.message}`);
      return { ok: false, quota: motivo === 'quotaExceeded' || motivo === 'dailyLimitExceeded' };
    }
    const item = (data.items || [])[0];
    const videoId = item && item.id && item.id.videoId;
    if (!videoId) return { ok: true, item: null };
    return {
      ok: true,
      item: {
        id: canal.id,
        n: canal.n,
        plat: 'youtube',
        videoId,
        videoTitle: item.snippet.title,
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      }
    };
  } catch (e) {
    console.error(`Erro checando live de ${canal.n}:`, e.message);
    return { ok: false, quota: false };
  }
}

// Checagem completa do YouTube. Mescla com o estado anterior: canal com erro mantem o
// que ja estava salvo; canal checado com sucesso e substituido pelo resultado novo.
async function checarYoutubeCompleto(anteriorYoutube) {
  const resultados = await Promise.all(CANAIS_YOUTUBE.map(checarLiveDoCanalYoutube));
  const live = [];
  let erros = 0;
  resultados.forEach((r, i) => {
    const canal = CANAIS_YOUTUBE[i];
    if (r.ok) {
      if (r.item) live.push(r.item);
    } else {
      erros++;
      anteriorYoutube.filter(c => c.id === canal.id).forEach(c => live.push(c));
    }
  });
  const quota = resultados.some(r => !r.ok && r.quota);
  console.log(`YouTube: ${CANAIS_YOUTUBE.length} canal(is) checado(s) via search.list, ${live.length} ao vivo agora, ${erros} erro(s)${quota ? ' (COTA ESGOTADA)' : ''}.`);
  return live;
}

// Reconfere (1 unidade de cota) as lives do YouTube ja marcadas: remove as que acabaram.
// Qualquer falha mantem a lista como esta.
async function reconferirLivesYoutube(listaYoutube) {
  const ids = listaYoutube.map(c => c.videoId).filter(Boolean);
  if (!ids.length) return listaYoutube;
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${ids.join(',')}&key=${API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      console.warn(`Aviso: reconferencia (videos.list) falhou: ${data.error.message} -- mantendo lista.`);
      return listaYoutube;
    }
    const aoVivo = new Set((data.items || [])
      .filter(v => v.snippet && v.snippet.liveBroadcastContent === 'live' &&
        !(v.liveStreamingDetails && v.liveStreamingDetails.actualEndTime))
      .map(v => v.id));
    const manter = listaYoutube.filter(c => aoVivo.has(c.videoId));
    if (manter.length !== listaYoutube.length) {
      console.log(`YouTube: reconferencia removeu ${listaYoutube.length - manter.length} live(s) encerrada(s).`);
    }
    return manter;
  } catch (e) {
    console.warn(`Aviso: reconferencia falhou: ${e.message} -- mantendo lista.`);
    return listaYoutube;
  }
}

// Retorna { live, tentou } -- live === null significa "falhou/pulou: mantenha o anterior".
async function processarYoutube(anterior) {
  const idsYoutube = new Set(CANAIS_YOUTUBE.map(c => c.id));
  const anteriorYoutube = anterior.live.filter(c => idsYoutube.has(c.id));

  if (!API_KEY) {
    console.warn('Aviso: YOUTUBE_API_KEY nao configurada -- pulando checagem do YouTube.');
    return { live: null, tentou: false };
  }
  if (process.env.SKIP_YOUTUBE === '1') {
    console.log('YouTube: checagem pulada nesta execucao (SKIP_YOUTUBE=1) -- mantendo estado anterior.');
    return { live: null, tentou: false };
  }
  try {
    if (deveChecarYoutube(anterior.youtubeCheckedAt)) {
      return { live: await checarYoutubeCompleto(anteriorYoutube), tentou: true };
    }
    console.log(`YouTube: ultima checagem completa em ${anterior.youtubeCheckedAt} (< ${YT_MIN_INTERVAL_MIN} min) -- so reconferindo lives ativas.`);
    return { live: await reconferirLivesYoutube(anteriorYoutube), tentou: false };
  } catch (e) {
    console.warn(`Aviso: falha checando o YouTube: ${e.message} -- mantendo estado anterior desses canais.`);
    return { live: null, tentou: true };
  }
}

async function pegarTokenTwitch() {
  const url = `https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`;
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(data.message || 'Twitch nao retornou access_token.');
  }
  return data.access_token;
}

async function checarTwitchLive() {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    console.warn('Aviso: TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET nao configurados -- pulando checagem da Twitch.');
    return null;
  }
  if (process.env.SKIP_TWITCH === '1') {
    console.log('Twitch: checagem pulada nesta execucao (SKIP_TWITCH=1) -- mantendo estado anterior.');
    return null;
  }
  try {
    const token = await pegarTokenTwitch();
    const query = CANAIS_TWITCH.map(c => `user_login=${encodeURIComponent(c.login)}`).join('&');
    const res = await fetch(`https://api.twitch.tv/helix/streams?${query}`, {
      headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.error) {
      console.warn(`Aviso: erro da API da Twitch: ${data.message || data.error} -- mantendo estado anterior desses canais.`);
      return null;
    }
    const live = (data.data || []).map(stream => {
      const canal = CANAIS_TWITCH.find(c => c.login.toLowerCase() === stream.user_login.toLowerCase());
      if (!canal) return null;
      return {
        id: canal.id,
        n: canal.n,
        plat: 'twitch',
        login: canal.login,
        videoTitle: stream.title,
        videoUrl: `https://www.twitch.tv/${canal.login}`,
        thumbnail: (stream.thumbnail_url || '').replace('{width}', '440').replace('{height}', '248')
      };
    }).filter(Boolean);
    console.log(`Twitch: ${CANAIS_TWITCH.length} canal(is) checado(s), ${live.length} ao vivo agora.`);
    return live;
  } catch (e) {
    console.warn(`Aviso: falha checando a Twitch: ${e.message} -- mantendo estado anterior desses canais.`);
    return null;
  }
}

async function main() {
  const anterior = lerEstadoAnterior();
  const idsYoutube = new Set(CANAIS_YOUTUBE.map(c => c.id));
  const idsTwitch = new Set(CANAIS_TWITCH.map(c => c.id));

  const [yt, liveTwitch] = await Promise.all([
    processarYoutube(anterior),
    checarTwitchLive(),
  ]);

  // null = a checagem dessa plataforma nao rodou ou falhou nessa execucao -> mantem o
  // que ja estava salvo pros canais dela.
  const resultadoYoutube = yt.live !== null ? yt.live : anterior.live.filter(c => idsYoutube.has(c.id));
  const resultadoTwitch = liveTwitch !== null ? liveTwitch : anterior.live.filter(c => idsTwitch.has(c.id));

  if (yt.live === null && liveTwitch === null && !anterior.live.length) {
    throw new Error('YouTube e Twitch falharam e nao ha estado anterior pra reaproveitar -- abortando pra nao gravar canais_live.json vazio por engano.');
  }

  const live = [...resultadoYoutube, ...resultadoTwitch];

  const payload = {
    updated: new Date().toISOString(),
    // Horario da ultima TENTATIVA de checagem completa (mesmo com erro, pra nao
    // martelar a API); se nao tentou nessa execucao, preserva o valor anterior.
    youtubeCheckedAt: yt.tentou ? new Date().toISOString() : anterior.youtubeCheckedAt,
    live
  };
  if (!payload.youtubeCheckedAt) delete payload.youtubeCheckedAt;

  fs.writeFileSync('canais_live.json', JSON.stringify(payload, null, 2) + '\n');
  console.log(`OK: ${live.length} canal(is) ao vivo agora (YouTube + Twitch).`);
  live.forEach(c => console.log(` - ${c.n}: ${c.videoTitle}`));
}

main().catch(err => {
  console.error('Erro ao checar lives:', err);
  process.exit(1);
});
