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
  let isStreaming = false;

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

  newSessionBtn?.addEventListener('click', () => {
    vscode.postMessage({ type: 'newSession' });
  });

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    streamingEl = document.createElement('div');
    streamingEl.className = 'message assistant streaming';

    streamingThinkingEl = document.createElement('div');
    streamingThinkingEl.className = 'thinking-block';
    streamingThinkingEl.style.display = 'none';
    streamingThinkingEl.addEventListener('click', () => streamingThinkingEl?.classList.toggle('expanded'));
    streamingEl.appendChild(streamingThinkingEl);

    streamingContentEl = document.createElement('div');
    streamingContentEl.className = 'message-content';
    streamingEl.appendChild(streamingContentEl);

    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    streamingContentEl.appendChild(cursor);

    messagesEl?.appendChild(streamingEl);
    isStreaming = true;
    sendBtn.disabled = true;
    if (stopBtn) stopBtn.style.display = 'block';
    scrollToBottom();
  }

  function appendThinkingChunk(text) {
    if (!streamingThinkingEl) return;
    streamingThinkingEl.style.display = 'block';
    streamingThinkingEl.textContent += text;
    scrollToBottom();
  }

  function appendTextChunk(text) {
    if (!streamingContentEl) return;
    const cursor = streamingContentEl.querySelector('.cursor');
    if (cursor) {
      cursor.insertAdjacentText('beforebegin', text);
    } else {
      streamingContentEl.textContent += text;
    }
    scrollToBottom();
  }

  function addToolCall(call) {
    if (!streamingEl) return;
    const el = document.createElement('div');
    el.className = 'tool-call';
    el.dataset.id = call.id;
    el.innerHTML = `<div class="tool-name">${escapeHtml(call.name)}</div><div class="tool-input">${escapeHtml(JSON.stringify(call.input, null, 2))}</div>`;
    const cursor = streamingContentEl?.querySelector('.cursor');
    if (cursor) {
      streamingEl.insertBefore(el, streamingContentEl);
    } else {
      streamingEl.appendChild(el);
    }
    scrollToBottom();
  }

  function updateToolCall(call) {
    const el = streamingEl?.querySelector(`[data-id="${call.id}"]`);
    if (!el) return;
    if (call.error) el.classList.add('error');
    const resultEl = document.createElement('div');
    resultEl.className = 'tool-result';
    const preview = (call.result || '').slice(0, 200);
    resultEl.textContent = preview + (call.result?.length > 200 ? '...' : '');
    el.appendChild(resultEl);
    scrollToBottom();
  }

  function finalizeStreaming() {
    if (!streamingContentEl) return;
    const cursor = streamingContentEl.querySelector('.cursor');
    cursor?.remove();
    streamingEl?.classList.remove('streaming');
    streamingEl = null;
    streamingContentEl = null;
    streamingThinkingEl = null;
    isStreaming = false;
    sendBtn.disabled = false;
    if (stopBtn) stopBtn.style.display = 'none';
    scrollToBottom();
  }

  function scrollToBottom() {
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
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
        if (messagesEl) messagesEl.innerHTML = '';
        isStreaming = false;
        sendBtn.disabled = false;
        streamingEl = null;
        streamingContentEl = null;
        streamingThinkingEl = null;
        break;
      case 'prefill':
        inputEl.value = msg.text;
        inputEl.focus();
        break;
    }
  });
})();
