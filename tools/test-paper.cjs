// paper.js 的启发式抽取回归测试（不依赖网络 / API Key / 真实 PDF）
// 跑法：node tools/test-paper.cjs
// 覆盖三种真实见过的版式：IEEE 双栏（小体大写标题）、ACL 编号章节、Springer LNCS（摘要与正文同行）
const paper = require('../paper');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  → ' + extra : '')); }
}
function run(tag, text, fileName, checks) {
  const parsed = { text, fileName, pageCount: 10, usedPages: 10, chars: text.length, bytes: 1024, truncated: false };
  const dg = paper.buildDigest(parsed);
  const r = paper.heuristic(parsed, dg);
  console.log('\n[' + tag + ']');
  console.log('  title : ' + r.meta.title);
  console.log('  author: ' + (r.meta.authors || '(空)'));
  console.log('  outline: ' + dg.outline.map((o) => o.key + '(' + o.chars + ')').join(' / '));
  checks(r, dg);
  return { r, dg };
}

// ---------- 1. IEEE 双栏：\textsc 把小体大写首字母拆开 ----------
const ieee = [
  'JOURNAL OF L A TEX CLASS FILES, VOL. ??, NO. ??, MONTH 20YY 1',
  'Unifying Large Language Models and',
  'Knowledge Graphs: A Roadmap',
  'Shirui Pan, Senior Member, IEEE , Linhao Luo,',
  'Yufei Wang, Chen Chen, Jiapu Wang, Xindong Wu, Fellow, IEEE',
  'Abstract —Large language models (LLMs) are making new waves in the field of natural language',
  'processing, due to their emergent ability and generalizability. However, LLMs often fall short of',
  'capturing and accessing factual knowledge. In this article, we present a forward-looking roadmap for',
  'the unification of LLMs and KGs. Our roadmap consists of three general frameworks.',
  '1 I NTRODUCTION',
  'Large language models (LLMs) have become a foundation of modern natural language processing.',
  'We aim to answer how LLMs and KGs can be unified to leverage their respective strengths.',
  '2 B ACKGROUND',
  'Knowledge graphs are structured knowledge models that explicitly store rich factual knowledge.',
  '8 C ONCLUSION',
  'Unifying LLMs and KGs is an active research direction. In this article, we provide a thorough',
  'overview of the recent research in this field. We conclude that the three frameworks are complementary.',
  'R EFERENCES',
  '[1] A. Carlson, “Toward an architecture for never-ending language learning,” in AAAI, 2010, pp. 1306–1313.',
].join('\n');

run('IEEE 双栏 + 小体大写伪影', ieee, '2306.08302.pdf', (r, dg) => {
  ok('标题不是文件名', r.meta.title !== '2306.08302', r.meta.title);
  ok('标题拼成完整句', /Unifying Large Language Models and Knowledge Graphs/.test(r.meta.title), r.meta.title);
  ok('作者识别出人名且不含 IEEE 等级', /Shirui Pan/.test(r.meta.authors) && !/Member/.test(r.meta.authors), r.meta.authors);
  ok('期刊模板占位页眉没被当成 venue', !/L A TEX|CLASS FILES/i.test(r.meta.venue), r.meta.venue);
  ok('摘要被单独切出来', dg.outline.some((o) => o.key === 'abstract'));
  ok('引言被识别（小体大写 I NTRODUCTION）', dg.outline.some((o) => o.key === 'intro'));
  ok('结论被识别（小体大写 C ONCLUSION）', dg.outline.some((o) => o.key === 'conclusion'));
  ok('没有"整篇 = 正文"的退化', !dg.outline.some((o) => o.key === 'body'));
  ok('研究问题取自引言的目标句', /how LLMs and KGs can be unified/i.test(r.researchQuestion.summary), r.researchQuestion.summary);
  ok('结论里没有参考文献条目', !r.findings.some((f) => /pp\.\s*\d/.test(f.claim)));
  ok('结论里没有右括号/小写开头的残句', !r.findings.some((f) => /^[a-z,;)]/.test(f.claim)));
});

// ---------- 2. ACL 编号章节 ----------
const acl = [
  'Card Extraction with Weak Supervision',
  'Alice Zhang, Bob Li, Carol Wang',
  'Institute of Computing Technology',
  'alice@example.com',
  'Abstract',
  'Business card parsing is a prerequisite for building contact management systems. Existing',
  'pipelines rely on commercial OCR services, which are expensive and hard to customise. This paper',
  'studies whether a small open-source stack can match them. We propose a two-stage extractor that',
  'first detects fields and then normalises them with a schema prior.',
  '1 Introduction',
  'Business cards remain the most common way to exchange contact information in industry.',
  '1.1 Motivation',
  'Contact management tools still ask users to type entries by hand after every meeting.',
  '3 Method',
  'Our approach consists of a detection stage and a normalisation stage. We build the detector on',
  'top of a lightweight layout model, and we adopt a schema prior to fix malformed values.',
  '4 Experiments',
  'We evaluate on a private dataset of 1,200 business cards. Results show that the open stack',
  'outperforms the commercial service on Chinese cards by 3.1 F1 points.',
  '5 Conclusion',
  'We show that a lightweight open-source pipeline can match commercial card parsing services.',
  'Future work will extend the evaluation to handwritten cards.',
  'References',
  '[1] Smith, J. “Card parsing at scale.” In KDD, 2019, pp. 12–20.',
].join('\n');

run('ACL 编号章节', acl, 'card-extraction.pdf', (r, dg) => {
  ok('标题正确', r.meta.title === 'Card Extraction with Weak Supervision', r.meta.title);
  ok('作者行不含单位/邮箱', !/@|Institute/.test(r.meta.authors), r.meta.authors);
  ok('方法章节被识别', dg.outline.some((o) => o.key === 'method'));
  ok('实验章节被识别', dg.outline.some((o) => o.key === 'experiment'));
  ok('结论句进了 findings', r.findings.some((f) => /lightweight open-source pipeline/i.test(f.claim)));
  ok('数字指标进了 findings', r.findings.some((f) => /3\.1 F1/i.test(f.claim)));
  ok('methods 有步骤', r.method.steps.length >= 1);
  ok('指标识别到 F1', r.method.metrics.includes('F1'), r.method.metrics.join(','));
});

// ---------- 3. Springer LNCS：摘要与正文挤在同一行 ----------
const llncs = [
  'LLM-Guided Ontology-Driven Knowledge Graph Construction',
  'Abdelhadi Belfadel and Sana Tmar',
  'Abstract. Constructing knowledge graphs from unstructured text still requires manual ontology',
  'design. We study how far an LLM can go in proposing an ontology by itself. We propose a pipeline',
  'that lets the model draft classes and relations, then validates them against the corpus.',
  '1 Introduction',
  'Knowledge graphs are widely used to organise facts extracted from text corpora.',
  '3 Proposed Pipeline',
  'Our method consists of three stages: ontology drafting, triple extraction and consistency repair.',
  'We employ a validation loop to reject relations that contradict the ontology.',
  '5 Conclusion',
  'We demonstrate that LLM-drafted ontologies reduce manual effort by roughly half.',
  'However, the approach still requires a human in the loop for schema changes.',
  'References',
  '[1] Hogan, A. “Knowledge graphs.” ACM Computing Surveys, 2021.',
].join('\n');

run('Springer LNCS 内联摘要', llncs, 'ontology.pdf', (r, dg) => {
  ok('摘要被识别（标题与正文同行）', dg.outline.some((o) => o.key === 'abstract'));
  ok('摘要章节名不是整行长句', dg.outline.every((o) => o.heading.length < 20), dg.outline.map((o) => o.heading).join('|'));
  ok('方法章节被识别', dg.outline.some((o) => o.key === 'method'));
  ok('研究问题落在摘要/引言内', r.researchQuestion.summary.length > 20);
  ok('limitations 抓到 however', r.limitations.some((s) => /however/i.test(s)), r.limitations.join('|'));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
