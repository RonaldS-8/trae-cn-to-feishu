import type { ToolCallInfo } from '../core/types.js';

export function hasComplexMarkdown(text: string): boolean {
  if (/```[\s\S]*?```/.test(text)) return true;
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

export function preprocessFeishuMarkdown(text: string): string {
  return text.replace(/([^\n])```/g, '$1\n```');
}

export function buildCardContent(text: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: [{ tag: 'markdown', content: text }],
    },
  });
}

export function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  });
}

export function htmlToFeishuMarkdown(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildToolProgressMarkdown(tools: ToolCallInfo[]): string {
  if (tools.length === 0) return '';
  const lines = tools.map(tc => {
    const icon = tc.status === 'running' ? '🔄' : tc.status === 'complete' ? '✅' : '❌';
    return `${icon} \`${tc.name}\``;
  });
  return lines.join('\n');
}

export function buildStreamingCard(text: string, tools: ToolCallInfo[]): string {
  const elements: unknown[] = [];

  const toolSection = buildToolProgressMarkdown(tools);
  if (toolSection) {
    elements.push({ tag: 'markdown', content: toolSection });
    elements.push({ tag: 'hr' });
  }

  const displayText = text.length > 28000 ? text.slice(0, 28000) + '\n...' : text;
  elements.push({ tag: 'markdown', content: displayText });

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🤖 Trae AI' },
      template: 'blue',
      ud_icon: 'chat_colorful',
    },
    body: { elements },
  });
}

export function buildPermissionButtonCard(
  text: string,
  permissionRequestId: string,
  chatId?: string,
): string {
  const buttons = [
    { label: '✅ Allow', type: 'primary', action: 'allow' },
    { label: '🔓 Allow Session', type: 'default', action: 'allow_session' },
    { label: '❌ Deny', type: 'danger', action: 'deny' },
  ];

  const buttonColumns = buttons.map(btn => ({
    tag: 'column',
    width: 'auto',
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: btn.label },
      type: btn.type,
      value: {
        callback_data: `perm:${btn.action}:${permissionRequestId}`,
        chatId: chatId || '',
      },
    }],
  }));

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '⚠️ Permission Required' },
      template: 'orange',
      ud_icon: 'confirm_colorful',
    },
    body: {
      elements: [
        { tag: 'markdown', content: text },
        { tag: 'hr' },
        {
          tag: 'column_set',
          columns: buttonColumns,
        },
      ],
    },
  });
}

export function buildResolvedPermissionCard(
  originalText: string,
  action: 'allow' | 'allow_session' | 'deny',
): string {
  const isAllow = action.startsWith('allow');
  const template = isAllow ? 'green' : 'red';
  const icon = isAllow ? '✅' : '❌';
  const label = action === 'allow' ? 'Allowed (once)' : action === 'allow_session' ? 'Allowed for session' : 'Denied';

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `${icon} Permission ${label}` },
      template,
    },
    body: {
      elements: [
        { tag: 'markdown', content: originalText },
      ],
    },
  });
}
