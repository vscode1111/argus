// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
  const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-send'));
  const stopBtn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-stop'));
  const newSessionBtn = document.getElementById('btn-new-session');

  let streamingEl = null;
  let streamingContentEl = null;
  let streamingThinkingEl = null;
  let streamingRawText = '';
  let isStreaming = false;
  let streamingStartTime = 0;

  const inputHistory = [];
  let historyIndex = -1;
  let savedDraft = '';

  function send() {
    const text = inputEl.value.trim();
    if (!text || isStreaming) return;
    inputHistory.unshift(text);
    historyIndex = -1;
    savedDraft = '';
    inputEl.value = '';
    inputEl.style.height = 'auto';
    vscode.postMessage({ type: 'send', text });
  }

  sendBtn.addEventListener('click', send);

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === 'ArrowUp' && inputHistory.length > 0) {
      e.preventDefault();
      if (historyIndex === -1) savedDraft = inputEl.value;
      historyIndex = Math.min(historyIndex + 1, inputHistory.length - 1);
      inputEl.value = inputHistory[historyIndex];
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
    } else if (e.key === 'ArrowDown' && historyIndex !== -1) {
      e.preventDefault();
      historyIndex--;
      inputEl.value = historyIndex === -1 ? savedDraft : inputHistory[historyIndex];
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
    }
  });

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
  });

  stopBtn?.addEventListener('click', () => {
    vscode.postMessage({ type: 'stop' });
  });

  document.getElementById('btn-kill')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'forceError' });
  });

  newSessionBtn?.addEventListener('click', () => {
    vscode.postMessage({ type: 'newSession' });
  });

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inlineMd(text) {
    // Split by inline code to protect it from other transformations
    const parts = text.split(/(`[^`]+`)/g);
    return parts.map((part, i) => {
      if (i % 2 === 1) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      let t = escapeHtml(part);
      t = t.replace(/\*\*\*\s*(.+?)\s*\*\*\*/g, '<strong><em>$1</em></strong>');
      t = t.replace(/\*\*\s*(.+?)\s*\*\*/g, '<strong>$1</strong>');
      t = t.replace(/\*\s*(.+?)\s*\*/g, '<em>$1</em>');
      t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
      return t;
    }).join('');
  }

  function renderTable(rows) {
    const parseRow = (row) => row.split('|').slice(1, -1).map(cell => cell.trim());
    const isSep = (row) => /^\|[\s\-|:]+\|$/.test(row.trim());
    const sepIdx = rows.findIndex(r => isSep(r));
    if (sepIdx === -1) { return rows.map(r => `<p>${inlineMd(r)}</p>`).join(''); }
    const headers = rows.slice(0, sepIdx);
    const body = rows.slice(sepIdx + 1).filter(r => r.trim());
    let html = '<table>';
    if (headers.length) {
      html += '<thead>' + headers.map(r =>
        '<tr>' + parseRow(r).map(c => `<th>${inlineMd(c)}</th>`).join('') + '</tr>'
      ).join('') + '</thead>';
    }
    if (body.length) {
      html += '<tbody>' + body.map(r =>
        '<tr>' + parseRow(r).map(c => `<td>${inlineMd(c)}</td>`).join('') + '</tr>'
      ).join('') + '</tbody>';
    }
    return html + '</table>';
  }

  function renderMarkdown(md) {
    if (!md) { return ''; }
    const lines = md.split('\n');
    const out = [];
    let inCode = false;
    let codeLines = [];
    let inUl = false;
    let inOl = false;
    let tableRows = [];

    function flushList() {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (inOl) { out.push('</ol>'); inOl = false; }
    }
    function flushTable() {
      if (tableRows.length) { out.push(renderTable(tableRows)); tableRows = []; }
    }

    for (const line of lines) {
      if (line.startsWith('```')) {
        if (!inCode) {
          flushList(); flushTable();
          inCode = true;
          codeLines = [];
        } else {
          inCode = false;
          out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        }
        continue;
      }
      if (inCode) { codeLines.push(line); continue; }

      // Table row
      if (line.trimStart().startsWith('|')) {
        flushList();
        tableRows.push(line);
        continue;
      }
      flushTable();

      if (!line.trim()) {
        flushList();
        out.push('');
        continue;
      }

      const h3 = line.match(/^### (.+)/);
      const h2 = line.match(/^## (.+)/);
      const h1 = line.match(/^# (.+)/);
      if (h3) { flushList(); out.push(`<h3>${inlineMd(h3[1])}</h3>`); continue; }
      if (h2) { flushList(); out.push(`<h2>${inlineMd(h2[1])}</h2>`); continue; }
      if (h1) { flushList(); out.push(`<h1>${inlineMd(h1[1])}</h1>`); continue; }

      if (/^---+$/.test(line)) { flushList(); out.push('<hr>'); continue; }

      const ul = line.match(/^[-*] (.+)/);
      if (ul) {
        if (inOl) { out.push('</ol>'); inOl = false; }
        if (!inUl) { out.push('<ul>'); inUl = true; }
        out.push(`<li>${inlineMd(ul[1])}</li>`);
        continue;
      }

      const ol = line.match(/^\d+\. (.+)/);
      if (ol) {
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (!inOl) { out.push('<ol>'); inOl = true; }
        out.push(`<li>${inlineMd(ol[1])}</li>`);
        continue;
      }

      flushList();
      out.push(`<p>${inlineMd(line)}</p>`);
    }

    flushList(); flushTable();
    if (inCode) { out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`); }
    return out.join('');
  }

  function appendMessage(msg) {
    const el = document.createElement('div');
    el.className = `message ${msg.role}`;
    el.dataset.id = msg.id;

    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = msg.content;
    el.appendChild(content);

    messagesEl?.appendChild(el);
    scrollToBottom();
    return el;
  }

  function startStreamingMessage() {
    streamingRawText = '';
    streamingEl = document.createElement('div');
    streamingEl.className = 'message assistant streaming';

    streamingThinkingEl = document.createElement('div');
    streamingThinkingEl.className = 'thinking-block';
    streamingThinkingEl.style.display = 'none';
    streamingThinkingEl.addEventListener('click', () => streamingThinkingEl?.classList.toggle('expanded'));
    streamingEl.appendChild(streamingThinkingEl);

    streamingContentEl = document.createElement('div');
    streamingContentEl.className = 'message-content';
    streamingContentEl.innerHTML = '<span class="cursor"></span>';
    streamingEl.appendChild(streamingContentEl);

    messagesEl?.appendChild(streamingEl);
    isStreaming = true;
    streamingStartTime = Date.now();
    sendBtn.disabled = true;
    if (stopBtn) { stopBtn.style.display = 'block'; }
    scrollToBottom();
  }

  function appendThinkingChunk(text) {
    if (!streamingThinkingEl) { return; }
    streamingThinkingEl.style.display = 'block';
    streamingThinkingEl.textContent += text;
    scrollToBottom();
  }

  function appendTextChunk(text) {
    if (!streamingContentEl) { return; }
    streamingRawText += text;
    streamingContentEl.innerHTML = renderMarkdown(streamingRawText) + '<span class="cursor"></span>';
    scrollToBottom();
  }

  function addToolCall(call) {
    if (!streamingEl) { return; }
    const el = document.createElement('div');
    el.className = 'tool-call';
    el.dataset.id = call.id;
    el.innerHTML = `<div class="tool-name">${escapeHtml(call.name)}</div><div class="tool-input">${escapeHtml(JSON.stringify(call.input, null, 2))}</div>`;
    if (streamingContentEl) {
      streamingEl.insertBefore(el, streamingContentEl);
    } else {
      streamingEl.appendChild(el);
    }
    scrollToBottom();
  }

  function updateToolCall(call) {
    const el = streamingEl?.querySelector(`[data-id="${call.id}"]`);
    if (!el) { return; }
    if (call.error) { el.classList.add('error'); }
    const resultEl = document.createElement('div');
    resultEl.className = 'tool-result';
    const preview = (call.result || '').slice(0, 200);
    resultEl.textContent = preview + (call.result?.length > 200 ? '...' : '');
    el.appendChild(resultEl);
    scrollToBottom();
  }

  function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    const rs = s % 60;
    return m + 'm ' + rs + 's';
  }

  function finalizeStreaming() {
    if (!streamingContentEl) { return; }
    streamingContentEl.innerHTML = renderMarkdown(streamingRawText);
    streamingRawText = '';

    const elapsed = Date.now() - streamingStartTime;
    const timerEl = document.createElement('div');
    timerEl.className = 'response-time';
    timerEl.textContent = formatDuration(elapsed);
    streamingEl?.appendChild(timerEl);

    streamingEl?.classList.remove('streaming');
    streamingEl = null;
    streamingContentEl = null;
    streamingThinkingEl = null;
    isStreaming = false;
    sendBtn.disabled = false;
    if (stopBtn) { stopBtn.style.display = 'none'; }
    scrollToBottom();
  }

  function scrollToBottom() {
    if (messagesEl) { messagesEl.scrollTop = messagesEl.scrollHeight; }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'message':
        if (msg.message.role === 'user') {
          appendMessage(msg.message);
        }
        break;
      case 'thinking_start':
        startStreamingMessage();
        break;
      case 'thinking_chunk':
        appendThinkingChunk(msg.text);
        break;
      case 'text_chunk':
        appendTextChunk(msg.text);
        break;
      case 'tool_start':
        addToolCall(msg.call);
        break;
      case 'tool_end':
        updateToolCall(msg.call);
        break;
      case 'done':
        finalizeStreaming();
        break;
      case 'error':
        finalizeStreaming();
        const errEl = document.createElement('div');
        errEl.className = 'message assistant';
        errEl.style.color = 'var(--error-fg)';
        errEl.textContent = 'Error: ' + msg.text;
        messagesEl?.appendChild(errEl);
        scrollToBottom();
        break;
      case 'clear':
        if (messagesEl) { messagesEl.innerHTML = ''; }
        isStreaming = false;
        sendBtn.disabled = false;
        streamingEl = null;
        streamingContentEl = null;
        streamingThinkingEl = null;
        streamingRawText = '';
        if (stopBtn) { stopBtn.style.display = 'none'; }
        break;
      case 'prefill':
        inputEl.value = msg.text;
        inputEl.focus();
        break;
    }
  });
})();
