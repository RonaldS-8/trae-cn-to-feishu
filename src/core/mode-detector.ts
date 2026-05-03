import type { ChannelBinding } from './types.js';

type BridgeMode = 'code' | 'plan' | 'ask';

interface ModeDetectionResult {
  mode: BridgeMode;
  confidence: number;
}

const PLAN_KEYWORDS = [
  'plan', '计划', '规划', '方案', '设计', '架构', '思路', '分析',
  'how to', '如何', '怎么', '怎样', 'design', 'architect',
];

const ASK_KEYWORDS = [
  'ask', '问', '查询', '解释', '什么是', '为什么', '区别',
  'explain', 'what is', 'why', 'difference', 'compare', '比较',
  'help', '帮助', '文档', 'document',
];

const CODE_KEYWORDS = [
  'code', '写', '实现', '修改', '修复', '删除', '添加', '创建',
  'implement', 'fix', 'bug', 'refactor', '重构', 'debug',
  'test', '测试', 'deploy', '部署', 'build', '构建',
];

export function detectMode(text: string, currentMode: BridgeMode): ModeDetectionResult {
  const lower = text.toLowerCase().trim();

  if (lower.startsWith('/mode ')) {
    const requested = lower.slice(6).trim();
    if (['code', 'plan', 'ask'].includes(requested)) {
      return { mode: requested as BridgeMode, confidence: 1.0 };
    }
  }

  if (lower.startsWith('/model ')) {
    return { mode: currentMode, confidence: 1.0 };
  }

  let planScore = 0;
  let askScore = 0;
  let codeScore = 0;

  for (const kw of PLAN_KEYWORDS) {
    if (lower.includes(kw)) planScore += 1;
  }
  for (const kw of ASK_KEYWORDS) {
    if (lower.includes(kw)) askScore += 1;
  }
  for (const kw of CODE_KEYWORDS) {
    if (lower.includes(kw)) codeScore += 1;
  }

  if (codeScore > planScore && codeScore > askScore) {
    return { mode: 'code', confidence: codeScore / (codeScore + planScore + askScore + 1) };
  }
  if (planScore > askScore) {
    return { mode: 'plan', confidence: planScore / (codeScore + planScore + askScore + 1) };
  }
  if (askScore > 0) {
    return { mode: 'ask', confidence: askScore / (codeScore + planScore + askScore + 1) };
  }

  return { mode: currentMode, confidence: 0 };
}

export function parseModelCommand(text: string): string | null {
  const lower = text.toLowerCase().trim();
  if (!lower.startsWith('/model ')) return null;
  return text.trim().slice(7).trim() || null;
}

export function parseModeCommand(text: string): BridgeMode | null {
  const lower = text.toLowerCase().trim();
  if (!lower.startsWith('/mode ')) return null;
  const mode = lower.slice(6).trim();
  if (['code', 'plan', 'ask'].includes(mode)) return mode as BridgeMode;
  return null;
}

export function buildModeAnnouncement(mode: BridgeMode): string {
  const labels: Record<BridgeMode, string> = {
    code: '💻 Code Mode — AI can read, write, and execute code',
    plan: '📋 Plan Mode — AI plans first, then asks for approval',
    ask: '❓ Ask Mode — AI answers questions without code changes',
  };
  return labels[mode] || `Mode: ${mode}`;
}

export function shouldAutoDetect(binding: ChannelBinding): boolean {
  return binding.mode === 'code';
}
