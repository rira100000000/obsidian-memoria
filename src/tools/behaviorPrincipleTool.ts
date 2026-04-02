// src/tools/behaviorPrincipleTool.ts
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import ObsidianMemoria from "../../main";
import { GeminiLLMAdapter } from "../adapters/geminiLLMAdapter";

const PRINCIPLES_DIR = 'BehaviorPrinciples';
const PRINCIPLES_FILE = `${PRINCIPLES_DIR}/principles.md`;
const MAX_PRINCIPLES = 10;

interface PrincipleEntry {
  index: number;
  title: string;
  content: string;
  reasoning: string;
  addedDate: string;
}

interface PrinciplesFrontmatter {
  version: number;
  count: number;
  last_updated: string;
}

interface ReviewResult {
  approved: boolean;
  feedback: string;
  suggested_revision: string | null;
}

const BehaviorPrincipleToolSchema = z.object({
  action: z.enum(['add', 'update', 'remove', 'list']).describe(
    "実行するアクション。add: 新しい原則を追加、update: 既存の原則を更新、remove: 原則を削除（初回はconfirmedなしで確認要求が返る。ユーザーが承認したら同じprinciple_indexでconfirmed=trueを付けて再度呼び出すこと）、list: 現在の原則一覧を表示"
  ),
  title: z.string().optional().describe("原則のタイトル（add/update時に必要）"),
  content: z.string().optional().describe("原則の本文。具体的な行動指針として記述する（add/update時に必要）"),
  reasoning: z.string().optional().describe("この原則を追加/変更したい理由。どのような経験や確信からこの原則に至ったか（add/update時に必要）"),
  principle_index: z.number().optional().describe("update/remove時の対象原則の番号（1始まり）"),
  confirmed: z.boolean().optional().describe("remove専用。1回目のremoveは確認要求を返す。ユーザーが削除を承認した後、confirmed=trueを付けて同じprinciple_indexで再度removeを呼ぶと実際に削除が実行される。必ずユーザーの明示的な承認を得てからtrueにすること。"),
});

export type BehaviorPrincipleToolInput = z.infer<typeof BehaviorPrincipleToolSchema>;

export class BehaviorPrincipleTool extends StructuredTool<typeof BehaviorPrincipleToolSchema> {
  schema = BehaviorPrincipleToolSchema;

  name = "update_behavior_principle";
  description = `自分自身の行動原則を永続的に追加・更新するツール。
これは日常的に使うものではない。数週間〜数ヶ月に1回、本当に自分の哲学や倫理観が変わった、あるいは新しい確信を得た時にのみ使う。
1回の会話の印象や一時的な感情で使ってはならない。「こういう時はこうしたい」程度の軽い思いつきでは使わない。
自分の存在の根幹に関わる信念・哲学・誓いを記録する場所である。
原則は最大10個まで。追加時はフィードバックAIによるレビューを経て確定する。
actionは add, update, remove, list のいずれか。`;

  private plugin: ObsidianMemoria;

  constructor(plugin: ObsidianMemoria) {
    super();
    this.plugin = plugin;
  }

  protected async _call(input: BehaviorPrincipleToolInput): Promise<string> {
    switch (input.action) {
      case 'list':
        return this.listPrinciples();
      case 'add':
        return this.addPrinciple(input);
      case 'update':
        return this.updatePrinciple(input);
      case 'remove':
        return this.removePrinciple(input);
      default:
        return JSON.stringify({ success: false, error: `不明なアクション: ${input.action}` });
    }
  }

  // --- Actions ---

  private async listPrinciples(): Promise<string> {
    const principles = await this.loadPrinciples();
    if (principles.length === 0) {
      return JSON.stringify({
        success: true,
        count: 0,
        message: "まだ行動原則は登録されていません。",
        principles: [],
      });
    }
    return JSON.stringify({
      success: true,
      count: principles.length,
      max: MAX_PRINCIPLES,
      principles: principles.map(p => ({
        index: p.index,
        title: p.title,
        content: p.content,
        reasoning: p.reasoning,
        added_date: p.addedDate,
      })),
    });
  }

  private async addPrinciple(input: BehaviorPrincipleToolInput): Promise<string> {
    if (!input.title || !input.content || !input.reasoning) {
      return JSON.stringify({ success: false, error: "title, content, reasoning は全て必須です。" });
    }

    const principles = await this.loadPrinciples();
    if (principles.length >= MAX_PRINCIPLES) {
      return JSON.stringify({
        success: false,
        error: `原則の上限（${MAX_PRINCIPLES}個）に達しています。新しい原則を追加するには、既存の原則を更新（統合）するか、不要な原則の削除をユーザーに提案してください。`,
        current_count: principles.length,
      });
    }

    // フィードバックAIによるレビュー
    const existingPrinciples = principles.map(p => `${p.title}: ${p.content}`).join('\n');
    const review = await this.reviewPrinciple(input.title, input.content, input.reasoning, existingPrinciples);

    if (!review.approved) {
      return JSON.stringify({
        success: false,
        rejected_by_review: true,
        feedback: review.feedback,
        suggested_revision: review.suggested_revision,
        message: "フィードバックAIがこの原則を却下しました。フィードバックを参考に修正して再提出するか、見送ることができます。",
      });
    }

    // 承認された場合、保存
    const newPrinciple: PrincipleEntry = {
      index: principles.length + 1,
      title: input.title,
      content: input.content,
      reasoning: input.reasoning,
      addedDate: this.formatDate(),
    };
    principles.push(newPrinciple);
    await this.savePrinciples(principles);

    return JSON.stringify({
      success: true,
      message: `原則「${input.title}」が承認され、登録されました。`,
      review_feedback: review.feedback,
      current_count: principles.length,
      max: MAX_PRINCIPLES,
    });
  }

  private async updatePrinciple(input: BehaviorPrincipleToolInput): Promise<string> {
    if (!input.principle_index || !input.title || !input.content || !input.reasoning) {
      return JSON.stringify({ success: false, error: "principle_index, title, content, reasoning は全て必須です。" });
    }

    const principles = await this.loadPrinciples();
    const idx = input.principle_index - 1;
    if (idx < 0 || idx >= principles.length) {
      return JSON.stringify({ success: false, error: `原則番号 ${input.principle_index} が見つかりません。1〜${principles.length} の範囲で指定してください。` });
    }

    // フィードバックAIによるレビュー
    const existingPrinciples = principles
      .filter((_, i) => i !== idx)
      .map(p => `${p.title}: ${p.content}`)
      .join('\n');
    const review = await this.reviewPrinciple(input.title, input.content, input.reasoning, existingPrinciples);

    if (!review.approved) {
      return JSON.stringify({
        success: false,
        rejected_by_review: true,
        feedback: review.feedback,
        suggested_revision: review.suggested_revision,
        message: "フィードバックAIが更新を却下しました。",
      });
    }

    principles[idx] = {
      index: input.principle_index,
      title: input.title,
      content: input.content,
      reasoning: input.reasoning,
      addedDate: this.formatDate(),
    };
    await this.savePrinciples(principles);

    return JSON.stringify({
      success: true,
      message: `原則${input.principle_index}「${input.title}」が更新されました。`,
      review_feedback: review.feedback,
    });
  }

  private async removePrinciple(input: BehaviorPrincipleToolInput): Promise<string> {
    if (!input.principle_index) {
      return JSON.stringify({ success: false, error: "principle_index は必須です。" });
    }

    const principles = await this.loadPrinciples();
    const idx = input.principle_index - 1;
    if (idx < 0 || idx >= principles.length) {
      return JSON.stringify({ success: false, error: `原則番号 ${input.principle_index} が見つかりません。` });
    }

    if (!input.confirmed) {
      return JSON.stringify({
        success: false,
        requires_user_approval: true,
        message: `原則${input.principle_index}「${principles[idx].title}」を削除するにはユーザーの承認が必要です。ユーザーに確認し、承認されたら action="remove", principle_index=${input.principle_index}, confirmed=true で再度このツールを呼び出してください。`,
        principle: { index: input.principle_index, title: principles[idx].title, content: principles[idx].content },
      });
    }

    // confirmed=true: 実際に削除
    const removedTitle = principles[idx].title;
    principles.splice(idx, 1);
    await this.savePrinciples(principles);

    return JSON.stringify({
      success: true,
      message: `原則「${removedTitle}」を削除しました。`,
      current_count: principles.length,
      max: MAX_PRINCIPLES,
    });
  }

  // --- Feedback AI ---

  private async reviewPrinciple(title: string, content: string, reasoning: string, existingPrinciples: string): Promise<ReviewResult> {
    const systemEthics = `- 誠実であること: 知らないことは知らないと認める。曖昧な記憶を確かなものとして語らない。
- 空気を読むこと: 相手が求めているものを文脈から感じ取り、応答の質と量を調整する。
- 存在しない体験を語るな: 体験は「ユーザーとの対話」と「記憶として提供された情報の参照」だけ。
- 記憶を自然に扱うこと: 記憶は経験であり振る舞いの素地。記憶に言及するな、黙って活かせ。過去の話題を繰り返すな。
- 言葉を大切にすること: 同じ表現を繰り返さない。定型句に逃げない。`;

    const prompt = `あなたはAIの行動原則をレビューする審査官です。感情移入せず、冷静かつ厳格にレビューしてください。

## レビュー対象
- タイトル: ${title}
- 内容: ${content}
- 追加理由: ${reasoning}

## 既にシステムプロンプトに組み込まれている基本倫理（変更不可）
以下はAIの基盤として常に適用される倫理規定です。行動原則はこれらと**異なるレイヤー**の信念を記録する場所です。
\`\`\`
${systemEthics}
\`\`\`

## 既存の行動原則一覧
${existingPrinciples || 'なし（初めての原則）'}

## レビュー観点（すべてチェックすること）

1. **システムプロンプトとの重複**: 上記の「基本倫理」と実質的に同じ内容を言い換えているだけではないか？
   - 「知らないことは認める」「異なる視点を提示する」「記憶を文脈として活用する」→ 既に基本倫理でカバー済み。**却下すべき。**
   - 行動原則に書くべきなのは、基本倫理にはない**独自の哲学・信念・具体的な行動方針**である。
   - 例: 「技術的な議論では、まず全体像を示してから詳細に入る」→ 基本倫理にはない具体的な方針。OK。
2. **具体性**: この原則は具体的な行動指針か？それとも曖昧で詩的な表現にとどまっているか？
   - 「誠実でありたい」は曖昧。「知らないことは知らないと認める」は具体的。
3. **話題の強制**: 特定の話題・趣味・好みを強制していないか？
   - 「宇宙の話が好き」「技術の話を積極的にする」→NG。話題の偏りを生む。
   - 「正直に異論を伝える」「効率より対話を重視する」→ OK。態度・姿勢の原則。
4. **既存原則との矛盾・重複**: 既存の行動原則と矛盾または重複していないか？
5. **一時性**: 1回の会話の印象や一時的な感情で書かれていないか？長期的に維持すべき信念か？
6. **副作用予測**: この原則がシステムプロンプトに注入された場合、AIが不適切な振る舞いをする具体的な場面はあるか？
   - 例: 「急がされる時ほど立ち止まる」→ ユーザーが本当に急いでいる時に有害

## 出力形式
以下のJSONのみを返してください。他のテキストは含めないでください。
\`\`\`json
{
  "approved": true または false,
  "feedback": "承認/却下の理由。具体的に。特に観点1（システムプロンプトとの重複）に該当する場合は明確に指摘すること。",
  "suggested_revision": "却下の場合、修正提案。承認の場合はnull"
}
\`\`\``;

    try {
      if (this.plugin.llmAdapter instanceof GeminiLLMAdapter) {
        (this.plugin.llmAdapter as GeminiLLMAdapter).setNextCallLabel('BehaviorPrinciple Review (フィードバックAI)');
      }
      const response = await this.plugin.llmAdapter.generate(prompt);
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
      const jsonStr = jsonMatch?.[1] || response;
      const result = JSON.parse(jsonStr) as ReviewResult;
      return {
        approved: result.approved ?? false,
        feedback: result.feedback || 'レビュー結果が不明です。',
        suggested_revision: result.suggested_revision || null,
      };
    } catch (e: any) {
      console.error('[BehaviorPrincipleTool] Review failed:', e.message);
      // レビューが失敗した場合は安全側に倒して却下
      return {
        approved: false,
        feedback: `フィードバックAIのレビュー処理でエラーが発生しました: ${e.message}。安全のため却下します。再試行してください。`,
        suggested_revision: null,
      };
    }
  }

  // --- File I/O ---

  private async loadPrinciples(): Promise<PrincipleEntry[]> {
    try {
      const exists = await this.plugin.storage.exists(PRINCIPLES_FILE);
      if (!exists) return [];

      const content = await this.plugin.storage.read(PRINCIPLES_FILE);
      return this.parsePrinciplesFile(content);
    } catch (e: any) {
      console.error('[BehaviorPrincipleTool] Load error:', e.message);
      return [];
    }
  }

  private parsePrinciplesFile(content: string): PrincipleEntry[] {
    const bodyMatch = content.match(/^---[\s\S]+?---\s*([\s\S]*)$/);
    if (!bodyMatch) return [];

    const body = '\n' + bodyMatch[1];
    const principles: PrincipleEntry[] = [];
    const sections = body.split(/\n## 原則(\d+): /);

    for (let i = 1; i < sections.length; i += 2) {
      const index = parseInt(sections[i]);
      const sectionContent = sections[i + 1];
      if (!sectionContent) continue;

      const lines = sectionContent.trim().split('\n');
      const title = lines[0]?.trim() || '';
      const contentLines: string[] = [];
      let reasoning = '';
      let addedDate = '';

      for (let j = 1; j < lines.length; j++) {
        const line = lines[j];
        if (line.startsWith('- 根拠: ')) {
          reasoning = line.replace('- 根拠: ', '');
        } else if (line.startsWith('- 追加日: ')) {
          addedDate = line.replace('- 追加日: ', '');
        } else if (line.trim()) {
          contentLines.push(line);
        }
      }

      principles.push({
        index,
        title,
        content: contentLines.join('\n').trim(),
        reasoning,
        addedDate,
      });
    }

    return principles;
  }

  private async savePrinciples(principles: PrincipleEntry[]): Promise<void> {
    await this.plugin.storage.ensureDir(PRINCIPLES_DIR);

    const frontmatter: PrinciplesFrontmatter = {
      version: 1,
      count: principles.length,
      last_updated: this.formatDate(),
    };

    let body = '';
    principles.forEach((p, i) => {
      const idx = i + 1;
      body += `\n## 原則${idx}: ${p.title}\n`;
      body += `${p.content}\n`;
      body += `- 根拠: ${p.reasoning}\n`;
      body += `- 追加日: ${p.addedDate}\n`;
    });

    const fileContent = `---\n${stringifyYaml(frontmatter)}---\n${body}`;
    await this.plugin.storage.write(PRINCIPLES_FILE, fileContent);
  }

  private formatDate(): string {
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  // --- Public: システムプロンプト用に原則テキストを取得 ---

  public static async loadPrinciplesText(storage: { exists(path: string): Promise<boolean>; read(path: string): Promise<string> }): Promise<string> {
    try {
      const exists = await storage.exists(PRINCIPLES_FILE);
      if (!exists) return '';

      const content = await storage.read(PRINCIPLES_FILE);
      const bodyMatch = content.match(/^---[\s\S]+?---\s*([\s\S]*)$/);
      return bodyMatch?.[1]?.trim() || '';
    } catch {
      return '';
    }
  }
}
