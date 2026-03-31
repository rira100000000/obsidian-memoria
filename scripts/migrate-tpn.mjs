/**
 * TPN マイグレーションスクリプト
 * 旧フォーマット → 新フォーマット（意味記憶 + エピソード記憶の2層構造）
 *
 * 使い方: node scripts/migrate-tpn.mjs /path/to/vault/TagProfilingNote
 */

import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';

const TPN_DIR = process.argv[2];
if (!TPN_DIR) {
  console.error('Usage: node scripts/migrate-tpn.mjs /path/to/TagProfilingNote');
  process.exit(1);
}

// --- 意味記憶の定義辞書 ---
// 一般的に知られた概念のみ定義。それ以外はエピソード記憶から推測するか「情報なし」
const SEMANTIC_DEFINITIONS = {
  'Ruby': 'Rubyは1995年にまつもとゆきひろによって開発されたオブジェクト指向プログラミング言語。動的型付けとメタプログラミングが特徴で、「楽しくプログラミングできること」を設計哲学とする。Ruby on Railsフレームワークの登場によりWeb開発分野で広く普及した。',
  'Rails': 'Ruby on Rails（通称Rails）は、Rubyで書かれたオープンソースのWebアプリケーションフレームワーク。「設定より規約（Convention over Configuration）」「DRY（Don\'t Repeat Yourself）」を原則とし、迅速なWeb開発を可能にする。2004年にDavid Heinemeier Hanssonによって公開された。',
  'SF': 'SF（サイエンス・フィクション）は、科学的な知見や仮説に基づいた架空の設定を用いる文学・映画・メディアのジャンル。宇宙探査、人工知能、タイムトラベル、ディストピアなどのテーマを通じて、人間の本質や社会のあり方を探求する。',
  'HAL': 'HAL（ハル）は、このプロジェクトにおけるAIキャラクターの名前。映画「2001年宇宙の旅」に登場する人工知能「HAL 9000」に由来する。obsidian-memoriaプラグイン上で動作し、ユーザーとの対話を通じて記憶を蓄積・成長するAIパートナーとして設計されている。',
  'Memoria': 'Memoriaは、obsidian-memoriaプラグインの略称・愛称。ラテン語で「記憶」を意味する。Obsidian上でAIとの対話履歴を永続化し、記憶として活用するシステム。',
  'obsidian-memoria': 'obsidian-memoriaは、ユーザー（rira）が開発しているObsidianプラグイン。Gemini APIを利用したAIチャット機能を持ち、会話の記憶をサマリーノート（SN）やタグプロファイリングノート（TPN）として永続化する。セマンティック検索による記憶想起、キャラクター設定によるAIペルソナなどの機能を備える。',
  'ruby-gemini-api': 'ruby-gemini-apiは、ユーザー（rira）が開発しているRuby用のGemini APIクライアントライブラリ（gem）。Google Gemini APIをRubyから簡単に利用するためのラッパーを提供する。',
  'セマンティック検索': 'セマンティック検索（意味検索）は、テキストの意味的な類似性に基づいて検索を行う技術。キーワードの完全一致ではなく、テキストをベクトル（エンベディング）に変換し、ベクトル間の類似度を計算することで、意味的に関連する文書を見つけ出す。',
  'アーキテクチャ': 'ソフトウェアアーキテクチャとは、システムの基本的な構造設計のこと。コンポーネントの分割、データの流れ、インターフェースの設計、技術選定などを含む。保守性、拡張性、パフォーマンスなどの品質特性に直接影響する。',
  'リファクタリング': 'リファクタリングとは、ソフトウェアの外部的な振る舞いを変えずに、内部構造を改善すること。コードの可読性、保守性、拡張性の向上を目的とする。Martin Fowlerの著書「Refactoring」で体系化された。',
  '疎結合': '疎結合（Loose Coupling）とは、ソフトウェア設計において、モジュール間の依存関係を最小限に抑える設計原則。各モジュールが独立して変更・テスト・デプロイできるようになり、システムの柔軟性と保守性が向上する。',
  '映画': '映画（Film / Movie）は、動画と音声を組み合わせた視聴覚メディアの一形態。物語、ドキュメンタリー、アニメーションなど多様なジャンルがあり、娯楽・芸術・教育など幅広い目的で制作される。',
  'マザー牧場': 'マザー牧場は、千葉県富津市にある観光牧場。約250ヘクタールの敷地に牛・羊・馬などの動物がおり、動物とのふれあい、乳搾り体験、花畑鑑賞、バンジージャンプなどのアクティビティが楽しめる。',
  '中山法華経寺': '中山法華経寺（なかやまほけきょうじ）は、千葉県市川市中山にある日蓮宗の大本山。正式名称は正中山法華経寺。1260年に創建され、日蓮聖人が最初に開いた寺院の一つとされる。国指定重要文化財の五重塔や祖師堂を有する。',
  '八丈島': '八丈島は、東京都に属する伊豆諸島南部の火山島。東京から南方約287kmに位置し、面積約69km²。亜熱帯性気候で、黄八丈（絹織物）や八丈島焼酎など独自の文化を持つ。温泉、ダイビング、トレッキングなどの観光地としても知られる。',
  '知育菓子': '知育菓子は、クラシエフーズが展開する知育目的の菓子シリーズ。水と粉を混ぜて形を作る工程を通じて、子供の創造力や好奇心を育む。「ねるねるねるね」「たのしいおすしやさん」「ポッピンクッキン」シリーズなどが代表的。',
  'API構想': 'obsidian-memoriaの記憶管理機能をObsidianプラグインから分離し、独立したRails APIサーバーとして構築する構想。AIの記憶をObsidian Vaultに依存しない形で管理し、複数のクライアントからアクセス可能にすることを目指す。',
};

/**
 * エピソード記憶の内容からタグの意味を推測する
 */
function inferSemanticFromEpisodic(tagName, overviewContent, wholeBody) {
  // 個人的な概念・感情・抽象的なタグは推測可能な範囲で定義
  const inferences = {
    'ハル': 'ハルは、obsidian-memoriaプラグインで動作するAIキャラクターの名前（HALのカタカナ表記）。映画「2001年宇宙の旅」のHAL 9000に由来し、ユーザーとの対話を通じて成長するAIパートナー。',
    'カイ': 'カイは、ハル（HAL）の前にobsidian-memoriaで使用されていた、以前のAIキャラクターの名前。',
    'Assistant': 'Assistantは、AIの役割名の一つ。ハル（HAL）というキャラクターが確立する前の段階で使用されていた汎用的な呼称。',
    'パピコ': 'パピコは、江崎グリコが販売するチューブ型アイスクリーム菓子。2本に分けて食べられる独特の形状が特徴。',
    '菜の花': '菜の花（ナノハナ）は、アブラナ科の植物の花。春に鮮やかな黄色の花を咲かせ、日本では春の風物詩として親しまれる。食用としてもおひたしや天ぷらなどに利用される。',
    '末吉': '末吉は、ユーザー（rira）のルーツに関わる地名。',
    'こひつじ祭り': 'こひつじ祭りは、マザー牧場で開催される春の季節イベント。生まれたばかりの子羊とのふれあいが楽しめる。',
    '羊のラノリン': 'ラノリンは、羊の毛から分泌される天然の油脂（蝋）。保湿性に優れ、化粧品やスキンケア製品の原料として広く利用される。',
  };

  return inferences[tagName] || null;
}

async function migrateFile(filePath) {
  const content = await fs.readFile(filePath, 'utf-8');

  // frontmatter をパース
  const fmMatch = content.match(/^---([\s\S]+?)---/);
  if (!fmMatch) {
    return { status: 'error', reason: 'no frontmatter' };
  }

  let frontmatter;
  try {
    frontmatter = YAML.parse(fmMatch[1]);
  } catch (e) {
    return { status: 'error', reason: `yaml parse error: ${e.message}` };
  }

  // 既にマイグレーション済みならスキップ
  if (frontmatter.memory_type) {
    return { status: 'skipped', reason: 'already migrated' };
  }

  const tagName = frontmatter.tag_name || path.basename(filePath, '.md').replace(/^TPN-/, '');
  const body = content.slice(fmMatch[0].length).trim();

  // 本文からセクションを抽出
  const titleMatch = body.match(/^(#\s+.*)\n/);
  const titleLine = titleMatch ? titleMatch[1] : `# タグプロファイル: ${tagName}`;

  const extractSection = (name) => {
    const regex = new RegExp(`## ${name}\\s*([\\s\\S]*?)(?=\\n## |$)`);
    const match = body.match(regex);
    return match ? match[1].trim() : '';
  };

  const overview = extractSection('概要');
  const contexts = extractSection('これまでの主な文脈');
  const opinions = extractSection('ユーザーの意見・反応');
  const otherNotes = extractSection('その他メモ');

  // 意味記憶を生成
  let semanticContent = SEMANTIC_DEFINITIONS[tagName] || null;
  if (!semanticContent) {
    semanticContent = inferSemanticFromEpisodic(tagName, overview, body);
  }

  const hasSemantic = !!semanticContent;
  frontmatter.memory_type = { semantic: hasSemantic, episodic: true };

  // 新しい本文を構築
  let newBody = `${titleLine}\n\n`;

  if (hasSemantic) {
    newBody += `## What it is（意味記憶）\n\n${semanticContent}\n\n`;
  }

  newBody += `## What it means to us（エピソード記憶）\n\n`;
  newBody += `### 概要\n\n${overview || '概要なし。'}\n\n`;
  newBody += `### これまでの主な文脈\n\n${contexts || '文脈情報なし。'}\n\n`;
  newBody += `### ユーザーの意見・反応\n\n${opinions || '意見・反応なし。'}\n\n`;
  newBody += `### その他メモ\n\n${otherNotes || '特記事項なし。'}\n`;

  // ファイルを上書き
  const newFrontmatter = YAML.stringify(frontmatter);
  const newContent = `---\n${newFrontmatter}---\n\n${newBody}`;
  await fs.writeFile(filePath, newContent, 'utf-8');

  return { status: 'migrated', hasSemantic, tagName };
}

async function main() {
  const files = (await fs.readdir(TPN_DIR)).filter(f => f.endsWith('.md'));
  console.log(`\nマイグレーション開始: ${files.length}件のTPNファイル\n`);

  let migrated = 0, skipped = 0, errors = 0;
  let semanticTrue = 0, semanticFalse = 0;
  const noSemanticTags = [];

  for (const file of files) {
    const filePath = path.join(TPN_DIR, file);
    const result = await migrateFile(filePath);

    if (result.status === 'migrated') {
      migrated++;
      if (result.hasSemantic) {
        semanticTrue++;
      } else {
        semanticFalse++;
        noSemanticTags.push(result.tagName);
      }
      console.log(`  [OK] ${file} (semantic: ${result.hasSemantic})`);
    } else if (result.status === 'skipped') {
      skipped++;
      console.log(`  [SKIP] ${file}: ${result.reason}`);
    } else {
      errors++;
      console.log(`  [ERROR] ${file}: ${result.reason}`);
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`マイグレーション完了:`);
  console.log(`  処理: ${migrated}件`);
  console.log(`  スキップ（マイグレーション済み）: ${skipped}件`);
  console.log(`  semantic: true（定義あり）: ${semanticTrue}件`);
  console.log(`  semantic: false（定義なし）: ${semanticFalse}件`);
  console.log(`  エラー: ${errors}件`);
  if (noSemanticTags.length > 0) {
    console.log(`\n定義なしタグ一覧:`);
    noSemanticTags.forEach(t => console.log(`  - ${t}`));
  }
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
