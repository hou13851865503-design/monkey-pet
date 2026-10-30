// PDF 论文解析（主进程用，不依赖 Electron）
//
// 思路参考 paper2gal.com 的解析管线，但**只要前半段**：
//   它是「PDF → 拆章节 → 逐章理解 → 生成剧情/对白」，
//   我们反过来停在「拆章节 → 逐章理解」，把理解结果直接结构化输出，
//   不做游戏化那一步。所以文件里只有 extract（抽取）/ digest（章节切分+压缩）
//   / analyze（理解）三段，没有任何渲染相关代码。
//
// 设计约束：
//   · 没有 API Key 也必须能用 → 内置一套启发式抽取兜底，输出字段和 LLM 路径完全一致
//   · 不把整篇论文塞给模型 → 按章节裁剪成 digest（摘要/引言尾/方法/结论优先）
'use strict';

const fs = require('fs');
const path = require('path');

// ---------- 输入限制 ----------
const LIMITS = {
  maxBytes: 30 * 1024 * 1024,   // 30 MB
  maxPages: 60,                 // 只看前 60 页
  minChars: 200,                // 少于这个字符数基本是扫描件
  maxChars: 400000,             // 抽取上限，防极端文件
};

let pdfjs = null;
function getPdfjs() {
  if (!pdfjs) pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  return pdfjs;
}

// ---------- 1. 抽取 ----------
function validateFile(filePath) {
  let st;
  try { st = fs.statSync(filePath); } catch (_) { throw new Error('文件不存在或无法读取'); }
  if (!st.isFile()) throw new Error('这不是一个文件');
  if (st.size === 0) throw new Error('文件是空的');
  if (st.size > LIMITS.maxBytes) {
    throw new Error(`文件 ${(st.size / 1048576).toFixed(1)}MB，超过 ${LIMITS.maxBytes / 1048576}MB 上限`);
  }
  if (path.extname(filePath).toLowerCase() !== '.pdf') throw new Error('只支持 .pdf 文件');
  // 不信任扩展名：读前 5 字节看是不是 %PDF-
  const fd = fs.openSync(filePath, 'r');
  const head = Buffer.alloc(5);
  try { fs.readSync(fd, head, 0, 5, 0); } finally { fs.closeSync(fd); }
  if (head.toString('latin1') !== '%PDF-') throw new Error('文件头不是 %PDF-，可能只是把别的文件改了后缀');
  return st.size;
}

async function extract(filePath, onProgress) {
  const size = validateFile(filePath);
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await getPdfjs().getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;

  const pageCount = doc.numPages;
  const take = Math.min(pageCount, LIMITS.maxPages);
  const pageTexts = [];
  let chars = 0;
  for (let i = 1; i <= take; i++) {
    if (chars >= LIMITS.maxChars) break;
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const text = joinItems(tc.items);
    pageTexts.push(text);
    chars += text.length;
    if (onProgress) onProgress({ stage: 'extract', page: i, pages: take, percent: 10 + Math.round((i / take) * 38) });
    page.cleanup();
  }
  try { doc.destroy(); } catch (_) {}

  return {
    fileName: path.basename(filePath),
    filePath,
    bytes: size,
    pageCount,
    usedPages: pageTexts.length,
    truncated: pageCount > take,
    chars,
    pageTexts,
    text: pageTexts.join('\n\n'),
  };
}

// pdfjs 的 items 是碎片的：带 hasEOL 的表示换行，其余按顺序拼
function joinItems(items) {
  let out = '';
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    out += it.str;
    if (it.hasEOL) out += '\n';
    else if (it.str && !/\s$/.test(it.str)) out += ' ';
  }
  return out
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    // 连字符换行："applicabil-\nity" → "applicability"
    .replace(/([a-z])-\n([a-z])/g, '$1$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- 2. 章节切分 ----------
// 论文标题行的特征：短、独占一行、常带编号。
// 匹配必须**整行等于**标题词（或 "Conclusion and Future Work" 这种短尾巴），
// 否则正文首行以 "evaluation of ..." / "framework." 开头就会被误判成章节，
// 会把整段正文吞进错误的章节里。
const SECTION_RULES = [
  ['abstract', ['abstract', '摘要']],
  ['intro', ['introduction', '引言', '前言']],
  ['related', ['related work', 'related works', 'background', 'prior work', '相关工作', '研究背景']],
  ['method', ['method', 'methods', 'methodology', 'approach', 'proposed method', 'proposed approach',
    'proposed pipeline', 'proposed framework', 'our approach', 'our method', 'pipeline',
    'architecture', 'design', '方法', '模型']],
  ['experiment', ['experiment', 'experiments', 'evaluation', 'experimental results', 'results', 'case study', '实验', '评估']],
  ['conclusion', ['conclusion', 'conclusions', 'discussion', 'concluding remarks', '总结', '结论']],
  ['references', ['references', 'bibliography', '参考文献']],
];

function headingOf(line) {
  const s = line.trim();
  if (!s) return null;

  // 标题和正文在同一行："Abstract. Ontology-driven ..." / "Abstract —Large language models ..."
  // 这种行会比较长，所以要在长度检查之前判断
  if (s.length <= 400) {
    const inline = /^(?:abstract|摘\s*要)\s*(?:[.．:：—–\-‑]|\s[—–])\s*(.{20,})$/i.exec(s);
    if (inline) return { key: 'abstract', rest: inline[1] };
  }
  if (s.length > 90) return null;

  // 去掉序号（"3." / "3.1" / "III."）和尾部标点
  const t = s
    .replace(/^(?:\d+(?:\.\d+)*\.?|[IVX]+[.)])\s+/, '')
    .replace(/^[\d.\s]+/, '')
    .replace(/[\s:：.。]+$/, '')
    .trim()
    .toLowerCase();
  if (!t || t.length > 40) return null;

  // LaTeX \textsc 小体大写会把首字母拆开，抽出来就是 "I NTRODUCTION" / "C ONCLUSION"，
  // 极端情况整词被拆成一串单字母。比较时把空白和连字符全压掉，才能和标题词对上。
  const squash = (v) => v.replace(/[\s\-‐-–—]+/g, '');

  for (const [key, words] of SECTION_RULES) {
    for (const w of words) {
      if (t === w || squash(t) === squash(w)) return { key, rest: '' };
      // 允许 "conclusion and future work" / "method and materials" 这类短尾巴
      if (t.startsWith(w + ' and ') && t.length <= w.length + 22) return { key, rest: '' };
    }
  }
  return null;
}

const LABEL = {
  front: '题名页', abstract: '摘要', intro: '引言', related: '相关工作 / 背景',
  method: '方法', experiment: '实验与结果', conclusion: '结论', references: '参考文献', body: '正文',
};

// \textsc 抽出来是 "1 I NTRODUCTION" / "3 R OADMAP & C ATEGORIZATION"：单词被拆成碎字母
function scattered(heading) {
  return /\b[A-Z]\s+[A-Z]{3,}\b/.test(heading || '') || /\b[A-Z](?:\s+[A-Z]\b){2,}/.test(heading || '');
}

function splitSections(rawText) {
  const lines = rawText.split('\n');
  const marks = [];
  lines.forEach((line, i) => {
    const hit = headingOf(line);
    if (hit) marks.push({ key: hit.key, rest: hit.rest, index: i, heading: line.trim() });
  });

  // 同一 key 只保留第一次出现（避免目录、页眉重复命中）
  const seen = new Set();
  const uniq = marks.filter((m) => (seen.has(m.key) ? false : (seen.add(m.key), true)));
  if (!uniq.length) return [{ key: 'body', heading: '正文', text: rawText }];

  const sections = [];
  // 第一个标题之前的内容算题名页（标题/作者/单位）
  if (uniq[0].index > 0) {
    sections.push({ key: 'front', heading: '题名页', text: lines.slice(0, uniq[0].index).join('\n') });
  }
  uniq.forEach((m, i) => {
    const end = i + 1 < uniq.length ? uniq[i + 1].index : lines.length;
    const body = lines.slice(m.index + 1, end).join('\n').trim();
    sections.push({
      key: m.key,
      // 标题和正文挤在一行时整行都是长句；\textsc 被抽出 "I NTRODUCTION" 这种碎字母时不值得给人看。
      // 两种情况都换成中文标签，正常能读的标题保持原样。
      heading: m.rest ? '摘要' : (scattered(m.heading) ? (LABEL[m.key] || m.heading) : m.heading),
      text: (m.rest ? m.rest + '\n' : '') + body,
    });
  });
  return sections;
}

// ---------- 3. 压缩成 digest（喂给模型的那一小段）----------
// paper2gal 是"逐章读"，我们按同样的顺序取，但每章只留头尾，控制 token
const CAP = {
  front: 700, abstract: 2200, intro: 1800, related: 600,
  method: 4000, experiment: 2600, conclusion: 2200, body: 3000, references: 0,
};

function clip(text, cap) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!cap || t.length <= cap) return t;
  const head = t.slice(0, Math.round(cap * 0.68));
  const tail = t.slice(-Math.round(cap * 0.32));
  return head + ' …… ' + tail;
}

// 在全文上均匀切片：有的论文标题格式很怪（全大写、带副标题），章节分不出来，
// 这时候不能只喂开头 —— 方法和结论都在后半篇。
function spread(text, budget, slots) {
  const t = (text || '').replace(/\s+/g, ' ');
  if (t.length <= budget) return t;
  const size = Math.floor(budget / slots);
  const out = [];
  for (let i = 0; i < slots; i++) {
    const at = Math.floor((t.length - size) * (i / Math.max(1, slots - 1)));
    out.push(t.slice(Math.max(0, at), Math.max(0, at) + size));
  }
  return out.join(' …… ');
}

function buildDigest(parsed) {
  const sections = splitSections(parsed.text);
  const parts = [];
  const outline = [];
  const have = new Set();

  for (const s of sections) {
    if (s.key === 'references') continue;
    have.add(s.key);
    const cap = CAP[s.key] == null ? 1500 : CAP[s.key];
    if (!cap) continue;
    outline.push({ key: s.key, heading: s.heading, chars: s.text.length });
    if (s.text) parts.push(`【${s.heading}】\n${clip(s.text, cap)}`);
  }

  // 一个章节都没认出来（整篇被当成 body）：按全文均匀抽样，而不是只截开头
  if (have.size === 1 && have.has('body')) {
    parts.length = 0;
    outline.length = 0;
    outline.push({ key: 'body', heading: '全文（未识别到章节标题）', chars: parsed.text.length });
    parts.push('【全文抽样（按篇幅均匀截取，段落顺序保持原样）】\n' + spread(parsed.text, 9000, 6));
  } else {
    // 方法/结论没认出来时补一段全文抽样，避免"没有方法"这种空结果
    const missing = [];
    if (!have.has('method')) missing.push('方法');
    if (!have.has('conclusion')) missing.push('结论');
    if (missing.length) {
      parts.push(`【全文抽样：用于补充${missing.join('与')}部分】\n` + spread(parsed.text, 3200, 4));
    }
  }
  return { sections, outline, digest: parts.join('\n\n') };
}

// ---------- 4a. 启发式抽取（无 API Key 时的兜底）----------
const STOP = /^(the|a|an|we|this|these|those|it|in|on|of|for|to|and|or|is|are|was|were|by|as|with|at|that|which)\b/i;

function sentences(text) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?。！？])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 24 && s.length < 400)
    // 题名页/作者/单位那种"很长、很多逗号、带邮箱"的碎片不要
    .filter((s) => (s.match(/,/g) || []).length < 4 && !/@|universit|institut|laborator|department of/i.test(s))
    // 脚注也不要（"contributed equally" 这类会被误当成研究问题）
    .filter((s) => !/contributed equally|corresponding author|equal contribution|[\u2217\u22c6\u2020\u2021]/i.test(s))
    // 分句切在了行中间：句首是小写 / 右括号收尾的都是残句
    .filter((s) => !/^[a-z,;)]/.test(s))
    // 参考文献条目（"… in WWW, 2007, pp. 697–706. [32] A. Carlson, …" 会被当成结论）
    .filter((s) => !/pp\.\s*\d|vol\.\s*\d+|\(\d{4}\)\s*$/.test(s))
    .filter((s) => (s.match(/\[\d{1,3}\]/g) || []).length < 2);
}

function pickBy(text, patterns, limit) {
  const out = [];
  for (const s of sentences(text)) {
    if (patterns.some((re) => re.test(s)) && !out.includes(s)) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

// 一行是不是"作者姓名列表"。标题折行常以 "… Models and" 收尾，所以以连接词结尾的不算；
// 姓名行的特征是首字母大写 + 只允许 and/&/de/van 这类连接词，且几乎没有小写单词。
function looksAuthorLine(l) {
  const s = (l || '').trim();
  if (!s || s.length < 6 || s.length > 300) return false;
  if (/\b(and|&)\s*$/.test(s)) return false;
  if (/[.!?]\s/.test(s)) return false;                       // 带句号的是正文
  const words = s.split(/\s+/).filter(Boolean);
  const lower = words.filter((w) => /^[a-z]/.test(w) && !/^(and|&|of|de|van|von|der|da|dos)$/.test(w));
  if (lower.length) return false;
  if (s.split(',').length >= 3) return true;                 // "A, B, C" 至少两个逗号
  if (words.length < 4 || words.length > 12) return false;
  const caps = words.filter((w) => /^[A-Z\u00c0-\u024f]/.test(w)).length;
  return caps >= words.length - 2 && /\band\b|&/.test(s);    // 必须有 "and"/"&" 连两组名字
}

// 标题经常被版式拆成两三行，所以要连续往下拼，直到遇到像作者/单位的行
function guessTitle(front, fileName, fullText) {
  const lines = (front || fullText || '').split('\n').map((l) => l.trim()).filter(Boolean);
  // 页眉/版权行：跳过继续往下找标题（IEEE 模板首页第一行就是 "JOURNAL OF ... VOL. ?? ..."）
  const header = /arxiv|doi|http|www\.|@|copyright|proceedings|conference on|journal of|vol\.|no\. \d|20yy|ieee transactions|preprint/i;
  // 作者/单位行：到这里说明上面已经是标题了，停
  const affiliate = /universit|institute|laborator|department|school of|inc\.|ltd/i;
  const out = [];
  for (const l of lines.slice(0, 10)) {
    if (l.length < 6) continue;
    if (/^\d+$/.test(l)) continue;                     // 纯页码
    if (header.test(l)) { if (out.length) break; else continue; }
    if (affiliate.test(l)) break;
    if (/^\d/.test(l) && out.length === 0) continue;   // 开头的编号
    // 先判断再 push，否则作者会被并进标题
    if (out.length > 0 && looksAuthorLine(l)) break;
    out.push(l);
    if (out.join(' ').length > 180) break;
    if (out.length >= 3) break;
  }
  const title = out.join(' ').replace(/\s+/g, ' ').trim();
  if (title.length >= 12) return title.slice(0, 200);
  return path.basename(fileName || 'paper.pdf', '.pdf');
}

// 数据集名：只抽"专名前缀 + dataset/corpus/benchmark"这种，别把整句塞进来
function guessData(text) {
  const out = [];
  const t = (text || '').replace(/\s+/g, ' ');
  const re1 = /([A-Z][\w'’\-]+(?:\s+[A-Z][\w'’\-]+){0,3})\s+(?:dataset|corpus|benchmark)/g;
  const re2 = /known as\s+([A-Z][^,.;]{2,40})/g;
  let m;
  while ((m = re1.exec(t)) && out.length < 4) {
    const v = m[1].trim();
    if (v.length >= 3 && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  while ((m = re2.exec(t)) && out.length < 4) {
    const v = m[1].trim().replace(/\s+/g, ' ');
    if (v.length >= 3 && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

// 作者行：标题下面那几行，有逗号、没有邮箱、不是单位。
// 作者多的时候会被版式拆成 2-3 行，要连着往下拼（"Shirui Pan, Senior Member, IEEE , Linhao Luo," + "Yufei Wang, ..."）
function guessAuthors(front) {
  const lines = (front || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const fake = /l\s*a\s*tex|class files|\?\?|20yy|journal of|vol\.|no\. \d|copyright|preprint|arxiv|under review/i;
  const isAuthorLine = (l) => {
    if (l.length < 8 || l.length > 300) return false;
    if (fake.test(l)) return false;
    if (/@|http|universit|institut|laborator|department|school of|inc\./i.test(l)) return false;
    if (/^(abstract|摘\s*要)/i.test(l)) return false;
    if (/\.\s+\S/.test(l)) return false;     // 带句号说明是正文句子
    return looksAuthorLine(l);
  };
  const at = lines.slice(0, 10).findIndex(isAuthorLine);
  if (at < 0) return '';
  const picked = [];
  for (let i = at; i < lines.length && picked.length < 3; i++) {
    if (!isAuthorLine(lines[i])) break;
    picked.push(lines[i]);
  }
  return picked.join(', ')
    .replace(/\b(?:Senior |Student )?Member,?\s*IEEE\b/gi, '')   // IEEE 会士等级不是名字
    .replace(/\bFellow,?\s*IEEE\b/gi, '')
    .replace(/[\u2217\u22c6\u2731\u2709*\u2020\u2021\u00a7\u00b6\d]+/g, '')   // 上标符号/脚注编号
    .replace(/\s*,\s*(?=,)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .slice(0, 240);
}

function guessVenue(text) {
  const src = text || '';
  // 期刊模板里的占位页眉（"JOURNAL OF L A TEX CLASS FILES, VOL. ??, NO. ??, MONTH 20YY"）
  // 不是真的发表信息，命中就跳过，继续找下一个候选
  const fake = /l\s*a\s*tex|class files|vol\.\s*\?|\?\?|20yy|month\s+\d{0,2}\s*$|anonymous|under review/i;
  const re = /(Proceedings of [^,.\n]{5,70}|Journal of [^,.\n]{3,60}|arXiv preprint[^\n]{0,50}|Lecture Notes in [^,.\n]{3,40})/gi;
  let m;
  while ((m = re.exec(src))) {
    const v = m[1].trim().replace(/\s+/g, ' ');
    if (!fake.test(v)) return v.slice(0, 80);
  }
  const m2 = /\b(ACL|EMNLP|NAACL|NeurIPS|ICLR|ICML|AAAI|IJCAI|SIGIR|KDD|WWW|CVPR|ICCV|TPAMI|TKDE)\b/.exec(src);
  return m2 ? m2[1] : '';
}

function heuristic(parsed, dg) {
  const get = (k) => (dg.sections.find((s) => s.key === k) || {}).text || '';
  const front = get('front');
  const abs = get('abstract') || get('body').slice(0, 2000) || parsed.text.slice(0, 2000);
  const intro = get('intro');
  // 方法/结论段落没被章节识别出来时，用全文抽样顶上 —— 总比输出"未识别"强。
  // 抽样从 8% 处开始，跳过题名页和作者信息。
  const skipFront = Math.floor(parsed.text.length * 0.08);
  const methodSec = get('method') || get('body');
  const bodySpread = methodSec ? '' : spread(parsed.text.slice(skipFront), 6000, 4);
  const exp = get('experiment');
  const concl = get('conclusion') || spread(parsed.text.slice(-Math.floor(parsed.text.length * 0.3)), 3000, 3);

  // 研究问题优先找"疑问/目标"句式；"In this paper we present …" 这种其实是贡献陈述，
  // 只在找不到疑问句时才拿来兜底（否则综述类论文的问题栏会写成"我们提出了路线图"）
  const rqStrong = pickBy(abs + ' ' + intro, [
    /\?\s*$/,                                       // 直接是疑问句
    /we (aim|seek|attempt) to/i,
    /the (goal|purpose|objective|aim) of (this|our) (paper|work|article|survey|study)/i,
    /(remains? (unclear|open|challenging)|open (problem|question)|is still unclear)/i,
    /we (address|investigate|study|examine|tackle|explore)/i,
    /how (to|can|should|do) /i,
  ], 3);
  const rqWeak = pickBy(abs + ' ' + intro, [/^(this|in this) (paper|work|study|article|survey|report)/i], 2);
  const rqSrc = rqStrong.length ? rqStrong : rqWeak;
  // 综述类没有独立的方法章节，它的"方法"就是分类框架，写在摘要/引言里。
  // 这时候用正文抽样去凑只会抽到零碎技术细节，所以优先从摘要+引言里找。
  const MP = [/we (propose|present|introduce|develop|design|build|adopt|employ)/i, /our (method|approach|framework|model|system|pipeline)/i, /consists? of/i];
  // 同一条句子不要同时挂到"研究问题"和"方法"下面 —— 综合起来会像复读机
  const methodSrc = pickBy(methodSec || (abs + ' ' + intro), MP, 5).filter((s) => !rqSrc.includes(s));
  const burstSrc = pickBy(bodySpread, MP, 3).filter((s) => !rqSrc.includes(s) && !methodSrc.includes(s));      // 只能当作 steps 的补充
  const findSrc = pickBy(concl + ' ' + exp, [
    /we (show|find|demonstrate|observe|achieve|conclude|argue|believe)/i,
    /results? (show|indicate|suggest|demonstrate)/i,
    /outperform/i, /improv(e|es|ed|ement)/i,
    /(suggest|indicat)e?s? that/i,
  ], 5);
  const contribSrc = pickBy(abs + ' ' + concl + ' ' + intro, [/contribution/i, /we (propose|introduce|present)/i, /first/i, /novel/i], 5)
    .filter((s) => !rqSrc.includes(s) && !methodSrc.includes(s));

  const year = ((front + ' ' + parsed.text.slice(0, 1200)).match(/\b(19[89]\d|20[0-4]\d)\b/) || [])[0] || '';
  const keywords = ['knowledge graph', 'large language model', 'ontology', 'retrieval', 'benchmark', 'reasoning']
    .filter((k) => new RegExp(k, 'i').test(parsed.text));

  return {
    engine: 'heuristic',
    meta: {
      title: guessTitle(front, parsed.fileName, parsed.text),
      authors: guessAuthors(front),
      year,
      venue: guessVenue(front + ' ' + parsed.text.slice(0, 1200)),
    },
    researchQuestion: {
      summary: rqSrc[0] || clip(abs, 240) || '（未在摘要/引言中识别到明确的研究问题句）',
      // 摘要里同一件事常被写两遍（长版＋短版），重复的子问题看着很傻
      subQuestions: rqSrc.slice(1, 4).filter((s) => {
        const head = s.slice(0, 32).toLowerCase();
        return !(rqSrc[0] || '').toLowerCase().includes(head);
      }),
    },
    method: {
      summary: methodSrc[0] || burstSrc[0] || clip(abs, 240) || '（未识别到方法段落）',
      steps: methodSrc.slice(1, 4).concat(burstSrc).slice(0, 4),
      data: guessData((methodSec || bodySpread) + ' ' + exp),
      metrics: (parsed.text.match(/\b(F1|BLEU|ROUGE|accuracy|precision|recall|MRR|nDCG|AUC)\b/gi) || [])
        .map((m) => m.toUpperCase()).filter((v, i, a) => a.indexOf(v) === i).slice(0, 6),
    },
    // 结论段没命中任何"结论句式"时，直接用结论的前两句 —— 结论的开头两句本身就是主张，
    // 比 clip() 那个"开头 160 字 + …… + 结尾 80 字"的拼接可信得多
    findings: (findSrc.length ? findSrc : (sentences(concl).slice(0, 2).length ? sentences(concl).slice(0, 2) : [clip(concl, 240) || '（未识别到结论段落）']))
      .slice(0, 5).map((s) => ({ claim: s, evidence: '' })),
    contributions: (contribSrc.length ? contribSrc : [clip(abs, 240) || '（未识别到贡献陈述）'])
      .slice(0, 4).map((s) => ({ point: s, type: '' })),
    limitations: pickBy(concl + ' ' + get('experiment'), [/limitation/i, /future work/i, /however/i], 3),
    keywords,
  };
}

// ---------- 4b. LLM 抽取 ----------
const SCHEMA_HINT = `{
  "meta": { "title": "论文标题", "authors": "作者（逗号分隔，没有就空字符串）", "year": "年份，如 2024", "venue": "期刊/会议，没有就空字符串" },
  "researchQuestion": { "summary": "一句话说清这篇论文要解决什么问题（不超过 80 字）", "subQuestions": ["更具体的子问题，0-3 条"] },
  "method": { "summary": "核心方法是什么（不超过 120 字）", "steps": ["方法的关键步骤，2-5 条，每条一句话"], "data": ["使用的数据集/语料"], "metrics": ["评价指标"] },
  "findings": [ { "claim": "主要结论，一句话", "evidence": "支撑它的实验数据或证据，没有就空字符串" } ],
  "contributions": [ { "point": "关键贡献，一句话", "type": "理论/方法/数据/系统 四选一" } ],
  "limitations": ["作者自己承认的局限或未来工作，0-3 条"],
  "keywords": ["3-6 个关键词"]
}`;

function buildPrompt(dg) {
  return [
    '你是论文精读助手。下面是按章节切分后的一篇论文内容（已压缩）。',
    '请只根据这些内容提取结构化信息，不要编造数据。',
    '必须只返回一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。',
    'JSON 字段结构如下：',
    SCHEMA_HINT,
    '注意：findings 与 contributions 都要 1-5 条；如果原文没写某字段，用空字符串或空数组，不要填“未提及”。',
    '',
    '=== 论文内容开始 ===',
    dg.digest.slice(0, 24000),
    '=== 论文内容结束 ===',
  ].join('\n');
}

function looseJson(s) {
  if (!s) return null;
  let t = String(s).trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (_) {}
  // 模型偶尔会把中文引号/尾逗号写坏，做一次温和修复
  try {
    const fixed = t.slice(a, b + 1)
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/[\u201c\u201d]/g, '"');
    return JSON.parse(fixed);
  } catch (_) { return null; }
}

function coerce(raw, parsed, dg) {
  const base = heuristic(parsed, dg);   // 用启发式结果填模型漏掉的字段
  if (!raw || typeof raw !== 'object') return base;
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
  const obj = (v) => (v && typeof v === 'object' ? v : {});
  const meta = obj(raw.meta), rq = obj(raw.researchQuestion), m = obj(raw.method);

  return {
    engine: 'llm',
    meta: {
      title: String(meta.title || '').trim() || base.meta.title,
      authors: String(meta.authors || '').trim(),
      year: String(meta.year || '').trim() || base.meta.year,
      venue: String(meta.venue || '').trim(),
    },
    researchQuestion: {
      summary: String(rq.summary || '').trim() || base.researchQuestion.summary,
      subQuestions: arr(rq.subQuestions),
    },
    method: {
      summary: String(m.summary || '').trim() || base.method.summary,
      steps: arr(m.steps),
      data: arr(m.data),
      metrics: arr(m.metrics),
    },
    findings: (Array.isArray(raw.findings) ? raw.findings : [])
      .map((f) => ({ claim: String(obj(f).claim || '').trim(), evidence: String(obj(f).evidence || '').trim() }))
      .filter((f) => f.claim).slice(0, 5),
    contributions: (Array.isArray(raw.contributions) ? raw.contributions : [])
      .map((c) => ({ point: String(obj(c).point || '').trim(), type: String(obj(c).type || '').trim() }))
      .filter((c) => c.point).slice(0, 5),
    limitations: arr(raw.limitations).slice(0, 3),
    keywords: arr(raw.keywords).slice(0, 8),
  };
}

// ---------- 对外 ----------
// opts.llm: async (messages, maxTokens) => { ok, text, error }
async function analyze(filePath, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  onProgress({ stage: 'read', percent: 6, text: '读取文件…' });
  const parsed = await extract(filePath, onProgress);

  if (parsed.chars < LIMITS.minChars) {
    throw new Error(`只抽到 ${parsed.chars} 个字符，这份 PDF 可能是扫描件（图片版），需要先做 OCR 才能解析`);
  }

  onProgress({ stage: 'split', percent: 54, text: '切分章节…' });
  const dg = buildDigest(parsed);

  let result = null;
  if (opts.llm) {
    onProgress({ stage: 'llm', percent: 62, text: '正在理解论文内容…' });
    try {
      const r = await opts.llm([{ role: 'user', content: buildPrompt(dg) }], 2000);
      if (r && r.ok) {
        const json = looseJson(r.text);
        if (json) result = coerce(json, parsed, dg);
        else result = Object.assign(heuristic(parsed, dg), { engine: 'heuristic', note: '模型返回的不是合法 JSON，已用启发式结果兜底' });
      } else if (r && r.error) {
        result = Object.assign(heuristic(parsed, dg), { engine: 'heuristic', note: 'AI 调用失败（' + r.error + '），已用启发式结果兜底' });
      }
    } catch (e) {
      result = Object.assign(heuristic(parsed, dg), { engine: 'heuristic', note: 'AI 调用异常，已用启发式结果兜底' });
    }
  }
  if (!result) result = heuristic(parsed, dg);

  onProgress({ stage: 'done', percent: 100, text: '完成' });
  return Object.assign(result, {
    meta: Object.assign(result.meta, {
      fileName: parsed.fileName,
      pageCount: parsed.pageCount,
      usedPages: parsed.usedPages,
      truncated: parsed.truncated,
      chars: parsed.chars,
      bytes: parsed.bytes,
    }),
    outline: dg.outline,
    excerpt: clip(dg.sections.map((s) => s.text).join(' '), 300),
    at: new Date().toISOString(),
  });
}

module.exports = { analyze, extract, splitSections, buildDigest, heuristic, LIMITS, looseJson };
