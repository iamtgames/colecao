// Verifica se algum canal de YouTube da lista "canais" esta transmitindo AO VIVO agora.
// Roda via GitHub Actions (.github/workflows/check-live.yml), sem chave de API:
// usa o atalho https://www.youtube.com/@handle/live, que o proprio YouTube
// redireciona (server-side) para o video mais recente/agendado daquele canal.
//
// Sinal confiavel = obj.microformat.playerMicroformatRenderer.liveBroadcastDetails.isLiveNow
// dentro do JSON "ytInitialPlayerResponse" embutido no HTML.
// NAO usar busca de string solta tipo html.includes('"isLiveNow":true') — isso da
// falso-positivo, pois essa mesma string aparece em QUALQUER video ao vivo listado
// na barra lateral de recomendados da pagina (ex.: abrir a /live de um canal que
// esta OFFLINE mas que tem, por acaso, um video de OUTRO canal ao vivo sugerido do
// lado, faz a busca ingenua acusar erroneamente que o canal errado esta ao vivo).
// A extracao abaixo isola o JSON do player do video PRINCIPAL da pagina (usando
// contagem de chaves, robusto a aspas/objetos aninhados) e le o campo isLiveNow
// especificamente dali, que reflete o status real do video principal.

const fs = require('fs');

// Mesmos ids/nomes do array "canais" no index.html — mantenha em sincronia
// ao adicionar/remover canais de YouTube na aba Vendedores/Lives/Leiloes.
const CANAIS_YOUTUBE = [
  { id: 1, n: 'Diego Sheth', handle: 'DiegoSheth' },
  { id: 2, n: 'Antec.r', handle: 'antec.r' },
  { id: 3, n: 'Garimpo dos Games', handle: 'Garimpodosgames' },
  { id: 4, n: 'Cara de Barata', handle: 'caradebarata' },
  { id: 5, n: 'DJ Games Retro', handle: 'djgamesretro' },
  { id: 6, n: 'Jotape Arcade', handle: 'JotapeArcade' },
  { id: 7, n: 'Sigchap', handle: 'sigchap' },
  { id: 9, n: 'Rodrigo Retro Games', handle: 'RodrigoRetroGames' },
  { id: 12, n: 'VG Invest', handle: 'vginvest' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .trim();
}

// Extrai o objeto JSON "var ytInitialPlayerResponse = {...};" do HTML usando
// contagem de chaves (respeitando strings/escapes), em vez de regex guloso —
// regex simples corta no lugar errado quando o JSON tem "};" dentro de strings.
function extrairPlayerResponse(html) {
  const key = 'var ytInitialPlayerResponse = ';
  const start = html.indexOf(key);
  if (start === -1) return null;
  const jsonStart = start + key.length;
  let depth = 0, i = jsonStart, inStr = false, esc = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  try {
    return JSON.parse(html.slice(jsonStart, i));
  } catch (e) {
    return null;
  }
}

async function checarCanal(canal) {
  try {
    const res = await fetch(`https://www.youtube.com/@${canal.handle}/live`, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'pt-BR,pt;q=0.9',
        // Sem esse cookie, o YouTube às vezes responde com a pagina de consentimento
        // de cookies em vez da pagina do canal (comum em datacenters/CI) — isso faz
        // a checagem de live falhar silenciosamente (nunca acha "isLiveNow":true).
        'Cookie': 'CONSENT=YES+1; SOCS=CAI',
        // Headers extras pra parecer mais com um navegador de verdade — o YouTube
        // serve uma variante "enxuta" (sem os dados de live) pra requisicoes vindas
        // de IPs de datacenter/CI que nao parecem um browser real.
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Sec-Fetch-Dest': 'document',
        'Upgrade-Insecure-Requests': '1',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"'
      }
    });
    if (!res.ok) return null;
    const html = await res.text();

    if (html.includes('consent.youtube.com') || html.includes('Before you continue')) {
      console.warn(`Aviso: pagina de consentimento do YouTube retornada para ${canal.n} — pulando.`);
      return null;
    }

    const player = extrairPlayerResponse(html);
    const micro = player && player.microformat && player.microformat.playerMicroformatRenderer
      ? player.microformat.playerMicroformatRenderer.liveBroadcastDetails
      : null;
    const isLiveNow = !!(micro && micro.isLiveNow === true);
    const playabilityStatus = player && player.playabilityStatus ? player.playabilityStatus.status : 'sem-player';
    console.log(`[debug] ${canal.n}: status=${res.status} tamanhoHtml=${html.length} playability=${playabilityStatus} isLiveNow=${isLiveNow}`);
    if (!isLiveNow) return null;

    const vd = player.videoDetails || {};
    const videoId = vd.videoId;
    let videoTitle = decodeEntities(vd.title || '');
    if (!videoTitle) videoTitle = canal.n;

    return {
      id: canal.id,
      n: canal.n,
      videoId,
      videoTitle,
      videoUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : `https://www.youtube.com/@${canal.handle}/live`,
      thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : ''
    };
  } catch (e) {
    console.error(`Erro checando ${canal.n}:`, e.message);
    return null;
  }
}

async function main() {
  const resultados = await Promise.all(CANAIS_YOUTUBE.map(checarCanal));
  const live = resultados.filter(Boolean);

  const payload = {
    updated: new Date().toISOString(),
    live
  };

  fs.writeFileSync('canais_live.json', JSON.stringify(payload, null, 2) + '\n');
  console.log(`OK: ${live.length} canal(is) ao vivo agora.`);
  live.forEach(c => console.log(` - ${c.n}: ${c.videoTitle}`));
}

main().catch(err => {
  console.error('Erro ao checar lives:', err);
  process.exit(1);
});
