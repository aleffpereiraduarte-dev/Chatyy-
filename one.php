<?php
/**
 * ONE AI Assistant — Personal AI for Chatyy
 * Conversational AI that can read emails, manage calendar, organize files,
 * send messages, and learn user preferences.
 *
 * Uses Claude API with tool_use for executing real actions.
 */

// ─── Config ───
// Helper to get PostgreSQL docs DB (same as docs.php uses)
function oneGetDocsDb(): PDO {
    require_once __DIR__ . '/db.php';
    return getPGDB();
}

ini_set("display_errors", 0);
set_time_limit(120); // ONE AI needs longer timeout for Claude API calls
set_error_handler(function($errno, $errstr, $errfile, $errline) {
    error_log("[One Error] $errstr in $errfile:$errline");
});
set_exception_handler(function($e) {
    error_log("[One Exception] " . $e->getMessage() . " in " . $e->getFile() . ":" . $e->getLine());
    if (!headers_sent()) {
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Internal error']);
    }
});
if (!defined('ONE_DB_PATH')) define('ONE_DB_PATH', __DIR__ . '/../data/one.db');
if (!defined('ONE_MODEL_SMART')) define('ONE_MODEL_SMART', 'gpt-4o-mini');
if (!defined('ONE_MODEL_FAST')) define('ONE_MODEL_FAST', 'gpt-4o-mini');
if (!defined('ONE_MAX_TOKENS')) define('ONE_MAX_TOKENS', 1024);
if (!defined('ONE_MAX_TOKENS_SMART')) define('ONE_MAX_TOKENS_SMART', 2048);
if (!defined('ONE_RATE_LIMIT')) define('ONE_RATE_LIMIT', 60);

// NOTE: This file is included from email.php via require_once.
// All functions from email.php (jsonResponse, getInput, requireAuth, etc.) are already available.

function oneLoadApiKey() {
    $key = getenv('OPENAI_API_KEY') ?: ($_ENV['OPENAI_API_KEY'] ?? $_SERVER['OPENAI_API_KEY'] ?? '');
    if (!$key && file_exists('/etc/mail-api.env')) {
        foreach (file('/etc/mail-api.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            if (strpos($line, '#') === 0) continue;
            if (strpos($line, 'OPENAI_API_KEY=') === 0) {
                $key = substr($line, strlen('OPENAI_API_KEY='));
                break;
            }
        }
    }
    return $key;
}

// ─── Personal Brain (per-user markdown file) ───
if (!defined('ONE_BRAIN_DIR')) define('ONE_BRAIN_DIR', __DIR__ . '/../data/one-brains');

function oneLoadBrain($email) {
    $path = ONE_BRAIN_DIR . '/' . md5(strtolower(trim($email))) . '.md';
    if (file_exists($path)) {
        return file_get_contents($path) ?: '';
    }
    return '';
}

function oneSaveBrain($email, $content) {
    if (!is_dir(ONE_BRAIN_DIR)) {
        @mkdir(ONE_BRAIN_DIR, 0755, true);
    }
    $path = ONE_BRAIN_DIR . '/' . md5(strtolower(trim($email))) . '.md';
    file_put_contents($path, $content, LOCK_EX);
}

/**
 * Auto-save brief notes to brain after successful tool actions.
 * This helps ONE reference past actions naturally in conversation.
 */
function oneAutoSaveBrainNote($email, $toolName, $toolInput, $toolResult) {
    // Only track significant actions
    $trackableActions = [
        'send_email' => 'Enviou email',
        'send_whatsapp' => 'Enviou WhatsApp',
        'send_sms' => 'Enviou SMS',
        'make_call' => 'Fez ligacao',
        'send_chat_message' => 'Enviou msg no chat',
        'create_calendar_event' => 'Criou evento',
        'create_reminder' => 'Criou lembrete',
        'create_meeting' => 'Criou reuniao',
        'create_document' => 'Criou documento',
        'create_spreadsheet' => 'Criou planilha',
        'add_expense' => 'Registrou gasto',
        'schedule_message' => 'Agendou mensagem',
        'schedule_whatsapp' => 'Agendou WhatsApp',
        'create_note' => 'Criou nota',
        'send_whatsapp_image' => 'Enviou imagem WhatsApp',
        'send_whatsapp_audio' => 'Enviou audio WhatsApp',
        'send_email_html' => 'Enviou email HTML',
        'forward_email' => 'Encaminhou email',
        'create_task' => 'Criou tarefa',
        'complete_task' => 'Completou tarefa',
        'create_shopping_list' => 'Criou lista de compras',
        'set_alarm' => 'Definiu alarme',
        'create_routine' => 'Criou rotina',
        'budget_create' => 'Criou orcamento',
        'sleep_log' => 'Registrou sono',
        'mood_log' => 'Registrou humor',
        'medication_reminder' => 'Configurou lembrete medicamento',
    ];

    if (!isset($trackableActions[$toolName])) return;

    $action = $trackableActions[$toolName];
    $date = date('d/m/Y H:i');
    $detail = '';

    switch ($toolName) {
        case 'send_email':
            $detail = "para {$toolInput['to']} sobre \"{$toolInput['subject']}\"";
            break;
        case 'send_whatsapp':
        case 'send_sms':
            $detail = "para {$toolInput['to']}";
            break;
        case 'make_call':
            $detail = "para {$toolInput['to']}";
            break;
        case 'send_chat_message':
            $detail = "para {$toolInput['recipient_email']}";
            break;
        case 'create_calendar_event':
            $detail = "\"{$toolInput['title']}\" em " . date('d/m', strtotime($toolInput['start_at'] ?? ''));
            break;
        case 'create_reminder':
            $detail = "\"{$toolInput['message']}\"";
            break;
        case 'add_expense':
            $detail = "R$ " . number_format($toolInput['amount'] ?? 0, 2, ',', '.') . " ({$toolInput['description']})";
            break;
        case 'schedule_whatsapp':
            $detail = "para {$toolInput['to']} em " . date('d/m H:i', strtotime($toolInput['send_at'] ?? ''));
            break;
        case 'send_whatsapp_image':
            $detail = "para {$toolInput['to']}";
            break;
        case 'send_whatsapp_audio':
            $detail = "para {$toolInput['to']}";
            break;
        case 'send_email_html':
            $detail = "para {$toolInput['to']} sobre \"{$toolInput['subject']}\"";
            break;
        case 'forward_email':
            $detail = "para {$toolInput['to']}";
            break;
        case 'create_task':
            $detail = "\"{$toolInput['title']}\"";
            break;
        case 'complete_task':
            $detail = $toolResult['message'] ?? '';
            break;
        case 'create_shopping_list':
            $detail = count($toolInput['items'] ?? []) . " itens";
            break;
        case 'set_alarm':
            $detail = "\"{$toolInput['label']}\" " . date('d/m H:i', strtotime($toolInput['time'] ?? ''));
            break;
        case 'create_routine':
            $detail = "\"{$toolInput['name']}\"";
            break;
        case 'budget_create':
            $detail = $toolInput['month'] ?? '';
            break;
        case 'sleep_log':
            $detail = ($toolInput['hours'] ?? 0) . "h";
            break;
        case 'mood_log':
            $detail = $toolInput['mood'] ?? '';
            break;
        case 'medication_reminder':
            $detail = "\"{$toolInput['medication']}\"";
            break;
        default:
            $detail = $toolResult['message'] ?? '';
            break;
    }

    // Append to brain activity log
    $brain = oneLoadBrain($email);
    $logEntry = "\n- [{$date}] {$action} {$detail}";

    if (strpos($brain, '## Historico de Acoes') !== false) {
        // Append to existing section - keep last 30 entries
        $parts = explode('## Historico de Acoes', $brain, 2);
        $existingLog = $parts[1] ?? '';
        $lines = array_filter(explode("\n", trim($existingLog)), function($l) { return str_starts_with(trim($l), '- ['); });
        $lines[] = trim($logEntry);
        // Keep only last 30
        $lines = array_slice($lines, -30);
        $brain = trim($parts[0]) . "\n\n## Historico de Acoes\n" . implode("\n", $lines) . "\n";
    } else {
        $brain .= "\n\n## Historico de Acoes\n" . trim($logEntry) . "\n";
    }

    oneSaveBrain($email, $brain);
}

/**
 * ElevenLabs Text-to-Speech — converts text to natural-sounding MP3 audio.
 */
function oneTextToSpeech($text) {
    $key = '';
    $voiceId = '';
    if (file_exists('/etc/mail-api.env')) {
        foreach (file('/etc/mail-api.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            if (strpos($line, '#') === 0) continue;
            if (strpos($line, 'ELEVENLABS_API_KEY=') === 0) $key = substr($line, 19);
            if (strpos($line, 'ELEVENLABS_VOICE_ID=') === 0) $voiceId = substr($line, 20);
        }
    }
    if (!$key || !$voiceId) return null;

    // Limit text to 5000 chars
    $text = mb_substr($text, 0, 5000);

    $ch = curl_init("https://api.elevenlabs.io/v1/text-to-speech/$voiceId");
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode([
            'text' => $text,
            'model_id' => 'eleven_multilingual_v2',
            'voice_settings' => ['stability' => 0.5, 'similarity_boost' => 0.75],
        ]),
        CURLOPT_HTTPHEADER => ["xi-api-key: $key", 'Content-Type: application/json', 'Accept: audio/mpeg'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 45,
    ]);
    $data = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);

    if ($data === false) {
        error_log("[One TTS] curl error: $err");
        return null;
    }
    if ($code !== 200) {
        error_log("[One TTS] ElevenLabs returned HTTP $code");
        return null;
    }
    return $data;
}

/**
 * Detect whether the user message needs the smart model (GPT-4o) or fast model (GPT-4o-mini).
 * Smart model for: writing, summarizing, analysis, translation, documents, complex reasoning.
 * Fast model for: reminders, calendar queries, contacts, simple Q&A, sending messages/calls.
 */
function oneNeedsSmartModel($message, $conversationId = null) {
    $smartKeywords = [
        // Portuguese - writing & composition
        'escreve', 'escreva', 'redige', 'redija', 'rascunho', 'draft',
        'resume', 'resumo', 'resuma', 'resumir',
        'analise', 'analisa', 'analisar', 'analyze',
        'traduz', 'traduza', 'traduzir', 'translate', 'traducao', 'traduzido',
        'cria documento', 'criar documento', 'create document',
        'cria planilha', 'criar planilha',
        'proposta', 'proposal',
        'planilha', 'spreadsheet',
        'relatório', 'relatorio', 'report',
        'email profissional', 'email formal',
        'texto longo', 'artigo', 'article',
        'explique', 'explain', 'explicar',
        'elabore', 'elaborar',
        'reescreve', 'reescreva', 'reescrever',
        'melhore', 'melhorar', 'melhorar o texto',
        'corrija', 'corrigir', 'corrigir o texto',
        'formalize', 'formalizar',
        'resuma os emails', 'resumo dos emails',
        'edita documento', 'editar documento',
        'documento', 'dados', 'calcula', 'calcular', 'calculo',
        'grafico', 'gráfico', 'chart', 'tabela',
        'foto', 'imagem', 'image', 'photo',
        'pesquisa', 'pesquisar', 'busca', 'buscar', 'web',
        'compara', 'comparar', 'comparativo', 'compare',
        'insight', 'tendencia', 'tendência', 'trend',
        'ocr', 'ler imagem', 'ler foto', 'descreva a foto', 'descreva a imagem',
        'arquivo do drive', 'ler arquivo',
        // Portuguese - cross-system & complex reasoning
        'tudo sobre', 'o que tenho sobre', 'o que sei sobre', 'informacoes sobre',
        'relacionado a', 'relacionado com', 'digest', 'resumo do dia', 'resumo completo',
        'sugira', 'sugerir', 'sugestao', 'sugestoes', 'recomende', 'recomendar',
        'planeje', 'planejar', 'planejamento', 'estrategia', 'estratégica',
        'priorize', 'priorizar', 'prioridades', 'organizar meu dia',
        'o que devo fazer', 'o que preciso fazer', 'pendencias', 'pendências',
        'financeiro', 'financas', 'finanças', 'gastos', 'quanto gastei',
        'me ajuda com', 'me ajude com', 'preciso de ajuda',
        'contexto', 'historico', 'histórico',
        'o que aconteceu', 'o que mudou', 'novidades',
        'decisao', 'decisão', 'decidir', 'avaliar', 'avaliacao',
        'complexo', 'detalhado', 'detalhada', 'aprofundado',
        // Financial, planning, strategy
        'investimento', 'investir', 'orcamento', 'orçamento', 'budget',
        'economia', 'economizar', 'poupar', 'poupanca',
        'plano de acao', 'plano de negocio', 'business plan',
        'roi', 'retorno', 'lucro', 'prejuizo',
        'fluxo de caixa', 'balanco', 'balanço', 'demonstrativo',
        'pros e contras', 'vantagens e desvantagens',
        'qual a melhor opcao', 'qual a melhor opção', 'o que voce acha',
        'me de sua opiniao', 'sua opiniao', 'avalie isso',
        'como funciona', 'como eu faco', 'me ensina',
        'passo a passo', 'tutorial', 'guia',
        'recomendacao', 'recomendação', 'recommendation',
        'estrategia', 'strategy', 'strategic',
        'financial', 'planning', 'analysis', 'comparison',
        // Multi-topic detection
        'alem disso', 'além disso', 'tambem quero', 'também quero',
        'outra coisa', 'e mais uma coisa', 'aproveitando',
        // English
        'summarize', 'write', 'compose', 'draft', 'analyze', 'translate',
        'create document', 'create spreadsheet', 'report', 'proposal',
        'explain', 'elaborate', 'rewrite', 'improve', 'formalize',
        'spreadsheet', 'document', 'data', 'calculate', 'search',
        'photo', 'image', 'describe', 'chart', 'graph', 'compare',
        'everything about', 'what do i have', 'related to', 'suggest',
        'plan my', 'prioritize', 'digest', 'what should i',
        'help me with', 'context', 'history', 'decision',
        'recommendation', 'strategy', 'financial', 'planning',
        'pros and cons', 'step by step', 'how does', 'teach me',
        // New tools keywords
        'tarefa', 'tarefas', 'task', 'tasks', 'to-do', 'todo',
        'lista de compras', 'shopping list', 'comprar',
        'alarme', 'alarm', 'despertador',
        'rotina', 'routine', 'matinal', 'noturna',
        'converter moeda', 'cambio', 'dolar', 'euro', 'currency',
        'dividir conta', 'split', 'gorjeta',
        'orcamento', 'budget', 'quanto posso gastar',
        'clima', 'tempo', 'weather', 'previsao', 'chover',
        'noticias', 'news', 'manchetes', 'headlines',
        'define', 'definicao', 'significado', 'dicionario',
        'fato curioso', 'curiosidade', 'random fact',
        'frase motivacional', 'motivacao', 'citacao', 'quote',
        'piada', 'joke', 'conta uma piada',
        'beber agua', 'hidratacao', 'water',
        'remedio', 'medicamento', 'medication',
        'sono', 'dormi', 'sleep', 'horas de sono',
        'humor', 'mood', 'me sentindo', 'estou me sentindo',
        'aniversario', 'birthday', 'aniversarios',
        'presente', 'gift', 'sugestao de presente',
        'compor mensagem', 'escrever mensagem', 'compose',
        'flashcard', 'flashcards', 'estudar', 'estudo',
        'receita', 'recipe', 'ingredientes', 'cozinhar',
        'reescrever', 'rewrite', 'mudar tom',
        'brainstorm', 'ideias', 'ideas',
        'template email', 'modelo de email',
    ];
    $lower = mb_strtolower($message);
    foreach ($smartKeywords as $kw) {
        if (mb_strpos($lower, $kw) !== false) return true;
    }
    // Long messages likely need deeper analysis
    if (mb_strlen($message) > 500) return true;
    // Questions with multiple clauses (complex queries)
    if (substr_count($lower, '?') > 1) return true;
    // Multiple topics in one message (commas + "e" connecting requests)
    if (preg_match('/\b(e|tambem|também|alem|além)\b.*\b(e|tambem|também|alem|além)\b/i', $lower)) return true;
    // Messages mentioning people by name + action (cross-system)
    if (preg_match('/\b(joao|maria|pedro|ana|carlos|fernanda|lucas|julia|rafael)\b.*(email|calendario|reuniao|contato|chat)/i', $lower)) return true;
    if (preg_match('/(email|calendario|reuniao|contato|chat).*(joao|maria|pedro|ana|carlos|fernanda|lucas|julia|rafael)\b/i', $lower)) return true;
    // If conversation has 10+ messages, use smart model (complex context)
    if ($conversationId) {
        try {
            $db = oneGetDb();
            $stmt = $db->prepare("SELECT COUNT(*) as cnt FROM one_messages WHERE conversation_id=:cid");
            $stmt->bindValue(':cid', $conversationId);
            $row = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
            $db->close();
            if (($row['cnt'] ?? 0) >= 10) return true;
        } catch (\Throwable $e) {}
    }
    return false;
}

// ─── Database ───
function oneGetDb() {
    $db = new SQLite3(ONE_DB_PATH);
    $db->busyTimeout(5000);
    $db->exec('PRAGMA journal_mode=WAL');
    $db->exec('PRAGMA foreign_keys=ON');

    // Conversations with One
    $db->exec("CREATE TABLE IF NOT EXISTS one_conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        title TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )");

    // Messages in One conversations
    $db->exec("CREATE TABLE IF NOT EXISTS one_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        content TEXT NOT NULL DEFAULT '',
        tool_calls TEXT DEFAULT NULL,
        tool_results TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (conversation_id) REFERENCES one_conversations(id) ON DELETE CASCADE
    )");

    // User preferences & learned patterns
    $db->exec("CREATE TABLE IF NOT EXISTS one_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'preference',
        key TEXT NOT NULL,
        value TEXT NOT NULL DEFAULT '',
        confidence REAL DEFAULT 1.0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_email, category, key)
    )");

    // Scheduled actions (reminders, auto-replies, etc.)
    $db->exec("CREATE TABLE IF NOT EXISTS one_scheduled (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        action_type TEXT NOT NULL,
        action_data TEXT NOT NULL DEFAULT '{}',
        trigger_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )");

    // Action log (what One did)
    $db->exec("CREATE TABLE IF NOT EXISTS one_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'success',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )");

    // Tasks
    $db->exec("CREATE TABLE IF NOT EXISTS one_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        due_date TEXT,
        priority TEXT DEFAULT 'medium',
        status TEXT DEFAULT 'pending',
        category TEXT DEFAULT 'general',
        assignee TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
    )");

    // Health logs (sleep, mood, water, etc)
    $db->exec("CREATE TABLE IF NOT EXISTS one_health_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        log_type TEXT NOT NULL,
        value TEXT NOT NULL,
        notes TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
    )");

    // Budgets
    $db->exec("CREATE TABLE IF NOT EXISTS one_budgets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        month TEXT NOT NULL,
        category TEXT NOT NULL,
        budget_amount REAL NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
    )");

    // Shopping lists
    $db->exec("CREATE TABLE IF NOT EXISTS one_shopping_lists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        list_name TEXT NOT NULL DEFAULT 'Lista de Compras',
        items TEXT NOT NULL DEFAULT '[]',
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
    )");

    // Routines
    $db->exec("CREATE TABLE IF NOT EXISTS one_routines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        name TEXT NOT NULL,
        steps TEXT NOT NULL DEFAULT '[]',
        days TEXT NOT NULL DEFAULT '[\"mon\",\"tue\",\"wed\",\"thu\",\"fri\",\"sat\",\"sun\"]',
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
    )");

        // Expense tracking
    $db->exec("CREATE TABLE IF NOT EXISTS one_expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        amount REAL NOT NULL,
        category TEXT NOT NULL DEFAULT 'other',
        description TEXT NOT NULL DEFAULT '',
        date TEXT NOT NULL,
        payment_method TEXT DEFAULT '',
        recurring INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )");

    return $db;
}

// ─── Tools Definition (what One can do) ───
function oneGetTools() {
    return [
        [
            'name' => 'list_recent_emails',
            'description' => 'List recent emails from a folder. Returns subject, from, date, uid, read status.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'folder' => ['type' => 'string', 'description' => 'Email folder (INBOX, Sent, Drafts, Trash, Archive)', 'default' => 'INBOX'],
                    'limit' => ['type' => 'integer', 'description' => 'Number of emails to return', 'default' => 10],
                ],
                'required' => [],
            ],
        ],
        [
            'name' => 'read_email',
            'description' => 'Read the full content of a specific email by UID.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'uid' => ['type' => 'integer', 'description' => 'Email UID'],
                    'folder' => ['type' => 'string', 'description' => 'Email folder', 'default' => 'INBOX'],
                ],
                'required' => ['uid'],
            ],
        ],
        [
            'name' => 'search_emails',
            'description' => 'Search emails by query (subject, from, body text).',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'query' => ['type' => 'string', 'description' => 'Search query'],
                    'folder' => ['type' => 'string', 'description' => 'Folder to search in', 'default' => 'INBOX'],
                    'limit' => ['type' => 'integer', 'description' => 'Max results', 'default' => 10],
                ],
                'required' => ['query'],
            ],
        ],
        [
            'name' => 'delete_email',
            'description' => 'Delete (move to Trash) an email by UID.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'uid' => ['type' => 'integer', 'description' => 'Email UID'],
                    'folder' => ['type' => 'string', 'description' => 'Current folder', 'default' => 'INBOX'],
                ],
                'required' => ['uid'],
            ],
        ],
        [
            'name' => 'move_email',
            'description' => 'Move an email to a different folder.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'uid' => ['type' => 'integer', 'description' => 'Email UID'],
                    'folder' => ['type' => 'string', 'description' => 'Current folder'],
                    'destination' => ['type' => 'string', 'description' => 'Target folder'],
                ],
                'required' => ['uid', 'folder', 'destination'],
            ],
        ],
        [
            'name' => 'send_email',
            'description' => 'Send an email. Always confirm with the user before sending.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'to' => ['type' => 'string', 'description' => 'Recipient email address'],
                    'subject' => ['type' => 'string', 'description' => 'Email subject'],
                    'body' => ['type' => 'string', 'description' => 'Email body (plain text)'],
                    'reply_to_uid' => ['type' => 'integer', 'description' => 'UID of email being replied to (optional)'],
                ],
                'required' => ['to', 'subject', 'body'],
            ],
        ],
        [
            'name' => 'create_calendar_event',
            'description' => 'Create a new calendar event with optional reminder.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'title' => ['type' => 'string', 'description' => 'Event title'],
                    'start_at' => ['type' => 'string', 'description' => 'Start datetime (ISO 8601, e.g. 2026-03-09T08:00:00)'],
                    'end_at' => ['type' => 'string', 'description' => 'End datetime (ISO 8601)'],
                    'description' => ['type' => 'string', 'description' => 'Event description', 'default' => ''],
                    'location' => ['type' => 'string', 'description' => 'Event location', 'default' => ''],
                    'reminder_minutes' => ['type' => 'integer', 'description' => 'Reminder before event in minutes', 'default' => 30],
                ],
                'required' => ['title', 'start_at'],
            ],
        ],
        [
            'name' => 'list_calendar_events',
            'description' => 'List upcoming calendar events. Can filter by attendee email or calendar name.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'days' => ['type' => 'integer', 'description' => 'Number of days ahead to look', 'default' => 7],
                    'attendee' => ['type' => 'string', 'description' => 'Filter events that include this attendee email (optional)'],
                    'calendar' => ['type' => 'string', 'description' => 'Filter by calendar name (optional)'],
                ],
                'required' => [],
            ],
        ],
        [
            'name' => 'create_reminder',
            'description' => 'Create a reminder for the user. Default delivery is WhatsApp (works for ANY number worldwide, no opt-in needed). Can also call or SMS.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'message' => ['type' => 'string', 'description' => 'Reminder message'],
                    'trigger_at' => ['type' => 'string', 'description' => 'When to trigger (ISO 8601 datetime)'],
                    'delivery' => ['type' => 'string', 'description' => 'How to deliver: whatsapp (default, most reliable), sms, call (voice call)', 'default' => 'whatsapp', 'enum' => ['whatsapp', 'sms', 'call', 'push']],
                    'phone' => ['type' => 'string', 'description' => 'Phone number with country code (e.g. +5511999998888). If provided, uses this number directly. Otherwise looks up saved number from memory.'],
                ],
                'required' => ['message', 'trigger_at'],
            ],
        ],
        [
            'name' => 'summarize_emails',
            'description' => 'Summarize recent unread emails with key highlights.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'folder' => ['type' => 'string', 'description' => 'Folder to summarize', 'default' => 'INBOX'],
                    'limit' => ['type' => 'integer', 'description' => 'Max emails to analyze', 'default' => 20],
                ],
                'required' => [],
            ],
        ],
        [
            'name' => 'remember_preference',
            'description' => 'Save something about the user that One should remember forever. Use this AGGRESSIVELY — save everything you learn about the user: names of family members, friends, coworkers, pets, preferences, habits, important dates, work info, health, hobbies, routines, emotional states, relationship details, and anything personally relevant.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'category' => ['type' => 'string', 'description' => 'Category: family (spouse, kids, parents, siblings), friends, work (boss, coworkers, company), preference (likes, dislikes, style), routine (daily habits, schedule), dates (birthdays, anniversaries), health, pets, hobbies, personality, contact_info, email_rule, financial, travel, food, music, goals'],
                    'key' => ['type' => 'string', 'description' => 'Short descriptive key (e.g. "wife_name", "favorite_restaurant", "son_birthday", "boss_name")'],
                    'value' => ['type' => 'string', 'description' => 'The details to remember, be specific and include context'],
                ],
                'required' => ['category', 'key', 'value'],
            ],
        ],
        [
            'name' => 'get_memories',
            'description' => 'Retrieve saved user preferences and learned patterns.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'category' => ['type' => 'string', 'description' => 'Filter by category (optional)'],
                ],
                'required' => [],
            ],
        ],
        [
            'name' => 'mark_email_read',
            'description' => 'Mark an email as read or unread.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'uid' => ['type' => 'integer', 'description' => 'Email UID'],
                    'folder' => ['type' => 'string', 'description' => 'Email folder', 'default' => 'INBOX'],
                    'read' => ['type' => 'boolean', 'description' => 'true=mark read, false=mark unread', 'default' => true],
                ],
                'required' => ['uid'],
            ],
        ],
        [
            'name' => 'draft_email',
            'description' => 'Save an email as draft (does NOT send). Use when user wants to prepare an email for later.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'to' => ['type' => 'string', 'description' => 'Recipient email'],
                    'subject' => ['type' => 'string', 'description' => 'Subject'],
                    'body' => ['type' => 'string', 'description' => 'Email body'],
                ],
                'required' => ['to', 'subject', 'body'],
            ],
        ],
        [
            'name' => 'list_contacts',
            'description' => 'List user contacts. Can search by name, email, or filter by group/tag.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'search' => ['type' => 'string', 'description' => 'Search by name or email (optional)'],
                    'group' => ['type' => 'string', 'description' => 'Filter by contact group/tag (e.g. "work", "family", "friends") (optional)'],
                ],
                'required' => [],
            ],
        ],
        [
            'name' => 'create_meeting',
            'description' => 'Create a video meeting room with a shareable link.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'title' => ['type' => 'string', 'description' => 'Meeting title'],
                    'participants' => ['type' => 'string', 'description' => 'Comma-separated email addresses of participants'],
                    'scheduled_at' => ['type' => 'string', 'description' => 'When the meeting starts (ISO 8601, optional for instant meetings)'],
                ],
                'required' => ['title'],
            ],
        ],
        [
            'name' => 'list_files',
            'description' => 'List user files from the file manager. Can search by name and filter by file type.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'folder_id' => ['type' => 'integer', 'description' => 'Folder ID (0 or omit for root)', 'default' => 0],
                    'search' => ['type' => 'string', 'description' => 'Search by filename (optional)'],
                    'file_type' => ['type' => 'string', 'enum' => ['photo', 'video', 'document', 'audio', 'archive', 'all'], 'description' => 'Filter by file type category (optional)', 'default' => 'all'],
                ],
                'required' => [],
            ],
        ],
        [
            'name' => 'get_daily_briefing',
            'description' => 'Get a complete daily briefing: unread emails summary, today calendar events, pending reminders. Use this when the user asks "what do I have today?" or says good morning.',
            'input_schema' => [
                'type' => 'object',
                'properties' => (object)[],
                'required' => [],
            ],
        ],
        [
            'name' => 'forget_memory',
            'description' => 'Delete a previously remembered preference or fact.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'key' => ['type' => 'string', 'description' => 'The key of the memory to forget'],
                ],
                'required' => ['key'],
            ],
        ],
        [
            'name' => 'send_chat_message',
            'description' => 'Send a chat message to another user on behalf of the current user. Use this when the user asks to send a message to someone via chat. Always confirm with the user before sending.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'recipient_email' => ['type' => 'string', 'description' => 'Email address of the recipient'],
                    'message' => ['type' => 'string', 'description' => 'The message text to send'],
                ],
                'required' => ['recipient_email', 'message'],
            ],
        ],
        [
            'name' => 'send_sms',
            'description' => 'Send an SMS text message to a phone number via Twilio. Always confirm with the user before sending. Use Brazilian format (+55...).',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'to' => ['type' => 'string', 'description' => 'Phone number with country code (e.g. +5511999998888)'],
                    'message' => ['type' => 'string', 'description' => 'The SMS text message to send (max 1600 chars)'],
                ],
                'required' => ['to', 'message'],
            ],
        ],
        [
            'name' => 'create_document',
            'description' => 'Cria um novo documento de texto (Word). O content pode ser HTML ou texto. Retorna o link para editar o documento.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'title' => ['type' => 'string', 'description' => 'Document title'],
                    'content' => ['type' => 'string', 'description' => 'Document content (HTML or plain text)'],
                    'folder_id' => ['type' => 'integer', 'description' => 'Folder ID to place the document in (optional)'],
                ],
                'required' => ['title', 'content'],
            ],
        ],
        [
            'name' => 'create_spreadsheet',
            'description' => 'Cria uma nova planilha (Excel). Informe os cabecalhos das colunas e opcionalmente os dados iniciais. Retorna o link para editar a planilha.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'title' => ['type' => 'string', 'description' => 'Spreadsheet title'],
                    'headers' => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => 'Column headers (e.g. ["Nome", "Email", "Telefone"])'],
                    'data' => ['type' => 'array', 'items' => ['type' => 'array', 'items' => ['type' => 'string']], 'description' => 'Row data as array of arrays (optional)'],
                    'folder_id' => ['type' => 'integer', 'description' => 'Folder ID to place the spreadsheet in (optional)'],
                ],
                'required' => ['title', 'headers'],
            ],
        ],
        [
            'name' => 'edit_document',
            'description' => 'Edita o conteudo de um documento existente.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'doc_id' => ['type' => 'integer', 'description' => 'Document ID (numeric)'],
                    'content' => ['type' => 'string', 'description' => 'New content for the document (HTML or plain text)'],
                ],
                'required' => ['doc_id', 'content'],
            ],
        ],
        [
            'name' => 'list_documents',
            'description' => 'Lista os documentos do usuario.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'folder_id' => ['type' => 'integer', 'description' => 'Filter by folder ID (optional)'],
                    'limit' => ['type' => 'integer', 'description' => 'Max documents to return', 'default' => 20],
                ],
                'required' => [],
            ],
        ],
        [
            'name' => 'search_users',
            'description' => 'Search for registered users by name, email, or phone number. Use this to find someone when they are not in the user\'s saved contacts.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'query' => [
                        'type' => 'string',
                        'description' => 'Search query - name, email, or phone number'
                    ]
                ],
                'required' => ['query']
            ]
        ],
        [
            'name' => 'send_whatsapp',
            'description' => 'Send a WhatsApp message to ANY phone number worldwide via UTILITY template. No opt-in or 24h window needed. Works for any country. Always confirm with the user before sending.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'to' => ['type' => 'string', 'description' => 'Phone number with country code (e.g. +5511999998888 for BR, +19547077804 for US)'],
                    'message' => ['type' => 'string', 'description' => 'The WhatsApp message to send'],
                ],
                'required' => ['to', 'message'],
            ],
        ],
        [
            'name' => 'make_call',
            'description' => 'Make an automated voice call to a phone number via Twilio. The message will be spoken by an AI voice in Brazilian Portuguese. Always confirm with the user before calling.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'to' => ['type' => 'string', 'description' => 'Phone number with country code (e.g. +5511999998888)'],
                    'message' => ['type' => 'string', 'description' => 'The message to speak during the call'],
                ],
                'required' => ['to', 'message'],
            ],
        ],
        [
            'name' => 'schedule_message',
            'description' => 'Schedule a message to be sent at a future date/time. Supports WhatsApp, SMS, email, chat, and voice call. Use this when user says "manda amanha", "envia as 8h", "me lembra de mandar", etc.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'type' => ['type' => 'string', 'description' => 'Message type: whatsapp, sms, email, chat, call'],
                    'to' => ['type' => 'string', 'description' => 'Recipient (phone number for whatsapp/sms/call, email address for email/chat)'],
                    'content' => ['type' => 'string', 'description' => 'Message content. For email, use JSON: {"subject":"...", "body":"..."}'],
                    'send_at' => ['type' => 'string', 'description' => 'When to send (ISO 8601 datetime, e.g. 2026-03-15T08:00:00)'],
                ],
                'required' => ['type', 'to', 'content', 'send_at'],
            ],
        ],
        [
            'name' => 'check_storage',
            'description' => 'Check the user storage usage on Chatyy Drive (files, documents, etc).',
            'input_schema' => [
                'type' => 'object',
                'properties' => (object)[],
                'required' => [],
            ],
        ],
        [
            'name' => 'get_plan_info',
            'description' => 'Get the current user plan info including plan name, storage used, storage limit, billing period, and subscription status',
            'input_schema' => ['type' => 'object', 'properties' => new stdClass(), 'required' => []],
        ],
        [
            'name' => 'subscribe_plan',
            'description' => 'Generate a link for the user to subscribe to a plan. Use when user wants to subscribe or upgrade.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'plan' => ['type' => 'string', 'description' => 'Plan name: "one" or "family"', 'enum' => ['one', 'family']],
                ],
                'required' => ['plan'],
            ],
        ],
        [
            'name' => 'cancel_plan',
            'description' => 'Cancel the user current subscription. Ask for confirmation first!',
            'input_schema' => ['type' => 'object', 'properties' => new stdClass(), 'required' => []],
        ],
        [
            'name' => 'read_document',
            'description' => 'Read the full content of a document (Word/text). Returns the document title, content (plain text), and metadata.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'document_id' => ['type' => 'integer', 'description' => 'The document ID to read'],
                ],
                'required' => ['document_id'],
            ],
        ],
        [
            'name' => 'read_spreadsheet',
            'description' => 'Read the data from a spreadsheet document. Returns rows and columns as a table. Headers and data are returned in a readable format.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'document_id' => ['type' => 'integer', 'description' => 'The spreadsheet document ID'],
                ],
                'required' => ['document_id'],
            ],
        ],
        [
            'name' => 'analyze_data',
            'description' => 'Analyze data from a spreadsheet - calculate sums, averages, count, min, max for specific columns. Can also filter rows.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'document_id' => ['type' => 'integer', 'description' => 'Spreadsheet document ID'],
                    'column' => ['type' => 'integer', 'description' => 'Column index (0-based) to analyze'],
                    'operation' => ['type' => 'string', 'enum' => ['sum', 'average', 'count', 'min', 'max', 'distinct'], 'description' => 'Operation to perform'],
                    'filter_column' => ['type' => 'integer', 'description' => 'Optional: column index to filter by'],
                    'filter_value' => ['type' => 'string', 'description' => 'Optional: value to filter for'],
                ],
                'required' => ['document_id', 'column', 'operation'],
            ],
        ],
        [
            'name' => 'read_chat_history',
            'description' => 'Read recent messages from a Chatyy chat conversation. Useful for understanding context or finding information discussed in chat.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'conversation_id' => ['type' => 'integer', 'description' => 'The conversation ID'],
                    'limit' => ['type' => 'integer', 'description' => 'Number of messages to read (default 20, max 50)'],
                ],
                'required' => ['conversation_id'],
            ],
        ],
        [
            'name' => 'analyze_photo',
            'description' => 'Analyze a photo or image using AI vision. Can describe what is in the image, read text from images (OCR), identify objects, etc.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'file_id' => ['type' => 'integer', 'description' => 'The file ID from Drive'],
                    'question' => ['type' => 'string', 'description' => 'What to analyze about the image (e.g. "what text is in this image?", "describe this photo")'],
                ],
                'required' => ['file_id'],
            ],
        ],
        [
            'name' => 'web_search',
            'description' => 'Search the web for current information. Use when you need up-to-date info, facts, prices, news, weather, etc.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'query' => ['type' => 'string', 'description' => 'The search query'],
                ],
                'required' => ['query'],
            ],
        ],
        [
            'name' => 'read_drive_file',
            'description' => 'Read the content of a text-based file from Chatyy Drive (txt, csv, json, xml, html, md, code files). CSV files are returned as formatted tables. For images use analyze_photo instead.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'file_id' => ['type' => 'integer', 'description' => 'The file ID from Drive'],
                ],
                'required' => ['file_id'],
            ],
        ],
        [
            'name' => 'add_expense',
            'description' => 'Record an expense/spending that the user mentions. Save the amount, category, description and date. Use this whenever the user mentions buying something, paying a bill, or any financial transaction.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'amount' => ['type' => 'number', 'description' => 'Amount in BRL (R$)'],
                    'category' => ['type' => 'string', 'enum' => ['food', 'transport', 'health', 'entertainment', 'bills', 'shopping', 'education', 'pets', 'home', 'travel', 'subscriptions', 'other'], 'description' => 'Expense category'],
                    'description' => ['type' => 'string', 'description' => 'What was bought/paid'],
                    'date' => ['type' => 'string', 'description' => 'Date in YYYY-MM-DD format'],
                    'payment_method' => ['type' => 'string', 'description' => 'pix, credit, debit, cash, etc'],
                    'recurring' => ['type' => 'boolean', 'description' => 'Is this a recurring monthly expense?'],
                ],
                'required' => ['amount', 'category', 'description', 'date'],
            ],
        ],
        [
            'name' => 'list_expenses',
            'description' => 'List expenses for a period. Can filter by category and date range. Returns totals and breakdown.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'start_date' => ['type' => 'string', 'description' => 'Start date YYYY-MM-DD (default: first of current month)'],
                    'end_date' => ['type' => 'string', 'description' => 'End date YYYY-MM-DD (default: today)'],
                    'category' => ['type' => 'string', 'description' => 'Filter by category (optional)'],
                ],
            ],
        ],
        [
            'name' => 'expense_report',
            'description' => 'Generate a complete financial report with totals by category, comparisons with previous period, and insights. Use when user asks about their spending.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'month' => ['type' => 'string', 'description' => 'Month in YYYY-MM format (default: current month)'],
                ],
            ],
        ],
        [
            'name' => 'find_related_info',
            'description' => 'Cross-search across emails, calendar, contacts, chat and memories for a person or topic. Use when the user asks "what do I have about João?", "tudo sobre a Maria", "o que tenho sobre o projeto X", etc. Searches emails from/to the person, calendar events mentioning them, contact info, chat conversations, and memories.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'query' => ['type' => 'string', 'description' => 'Person name, email, or topic to search across all systems'],
                    'include_emails' => ['type' => 'boolean', 'description' => 'Search in emails (default true)', 'default' => true],
                    'include_calendar' => ['type' => 'boolean', 'description' => 'Search in calendar (default true)', 'default' => true],
                    'include_contacts' => ['type' => 'boolean', 'description' => 'Search in contacts (default true)', 'default' => true],
                    'include_memories' => ['type' => 'boolean', 'description' => 'Search in saved memories (default true)', 'default' => true],
                    'include_chat' => ['type' => 'boolean', 'description' => 'Search in chat conversations (default true)', 'default' => true],
                ],
                'required' => ['query'],
            ],
        ],
        [
            'name' => 'daily_digest',
            'description' => 'Enhanced daily briefing with EVERYTHING: unread emails summary, today/tomorrow calendar events, pending reminders, expenses summary for this month, drive storage usage, recent chat messages, and any relevant memories. Use when user asks for a complete overview of their day or says "resumo completo", "digest", "me atualiza de tudo".',
            'input_schema' => [
                'type' => 'object',
                'properties' => (object)[],
                'required' => [],
            ],
        ],
        [
            'name' => 'smart_suggest',
            'description' => 'Analyze recent emails and calendar to suggest smart actions. Returns suggestions like: create event from email invite, add expense from bill email, set reminder for deadline, add contact from new sender, reply to important email. Use proactively or when user asks "o que preciso fazer?", "sugestoes", "pendencias".',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'limit' => ['type' => 'integer', 'description' => 'Max number of emails to analyze for suggestions', 'default' => 15],
                ],
                'required' => [],
            ],
        ],
        [
            'name' => 'update_brain',
            'description' => 'Update your personal brain file for this user. The brain is a markdown file where you store EVERYTHING you learn about the user. Call this to save/update observations. Always write the FULL content (replaces entire file).',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'content' => ['type' => 'string', 'description' => 'The FULL updated markdown content for the brain file. Must contain all sections.'],
                ],
                'required' => ['content'],
            ],
        ],
        [
            'name' => 'read_user_profile',
            'description' => 'Gather a comprehensive snapshot of everything about the current user: recent emails, calendar events, contacts, drive files, documents, chat conversations, storage usage, expenses, and saved memories. Use this on first conversation to build the initial brain, or periodically to update it.',
            'input_schema' => [
                'type' => 'object',
                'properties' => (object)[],
                'required' => [],
            ],
        ],
        [
            'name' => 'create_note',
            'description' => 'Create a quick note for the user. Saved in Chatyy Notes.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'title' => ['type' => 'string', 'description' => 'Note title'],
                    'content' => ['type' => 'string', 'description' => 'Note content (plain text)'],
                    'color' => ['type' => 'string', 'description' => 'Note color hex code. Options: #FFF9C4 (yellow), #F8BBD0 (pink), #C8E6C9 (green), #BBDEFB (blue), #D1C4E9 (purple), #FFE0B2 (orange), #FFFFFF (white), #E0E0E0 (gray)'],
                ],
                'required' => ['title', 'content'],
            ],
        ],
        [
            'name' => 'list_notes',
            'description' => 'List or search the user notes in Chatyy Notes.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'search' => ['type' => 'string', 'description' => 'Search query to filter notes by title or content'],
                    'limit' => ['type' => 'integer', 'description' => 'Max notes to return (default 20)'],
                ],
                'required' => [],
            ],
        ],
        [
            'name' => 'create_sticky',
            'description' => 'Create a sticky note that is pinned and shows prominently. Use for important reminders.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'title' => ['type' => 'string', 'description' => 'Sticky note title'],
                    'content' => ['type' => 'string', 'description' => 'Sticky note content'],
                    'color' => ['type' => 'string', 'description' => 'Color hex code (default #FFF9C4)'],
                ],
                'required' => ['title'],
            ],
        ],
        [
            'name' => 'translate',
            'description' => 'Translate text between languages. Supports any language pair. Returns the translated text.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'text' => ['type' => 'string', 'description' => 'Text to translate'],
                    'from' => ['type' => 'string', 'description' => 'Source language (e.g. Portuguese, English, Spanish). Can be "auto" for auto-detection.', 'default' => 'auto'],
                    'to' => ['type' => 'string', 'description' => 'Target language (e.g. English, Portuguese, Spanish, French, German, etc.)'],
                ],
                'required' => ['text', 'to'],
            ],
        ],
        [
            'name' => 'calculate',
            'description' => 'Perform math calculations, currency conversions, percentage calculations, and financial math. Use when the user mentions numbers, prices, discounts, tips, splits, interest, etc.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'expression' => ['type' => 'string', 'description' => 'Math expression or description of calculation (e.g. "15% of 250", "1500 / 3", "compound interest 1000 at 12% for 2 years", "150 USD to BRL")'],
                    'type' => ['type' => 'string', 'enum' => ['math', 'percentage', 'split', 'tip', 'interest', 'conversion'], 'description' => 'Type of calculation', 'default' => 'math'],
                ],
                'required' => ['expression'],
            ],
        ],
        [
            'name' => 'analyze_email',
            'description' => 'Deep analysis of a specific email. Extracts: action items, deadlines, sentiment (positive/negative/neutral), key people mentioned, summary, and suggested follow-up actions. Use when user asks to understand or analyze a complex email.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'uid' => ['type' => 'integer', 'description' => 'Email UID to analyze'],
                    'folder' => ['type' => 'string', 'description' => 'Email folder', 'default' => 'INBOX'],
                ],
                'required' => ['uid'],
            ],
        ],
        [
            'name' => 'schedule_whatsapp',
            'description' => 'Schedule a WhatsApp message to be sent at a future date/time. The message will be sent automatically when the time arrives.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'to' => ['type' => 'string', 'description' => 'Phone number with country code (e.g. +5511999998888)'],
                    'message' => ['type' => 'string', 'description' => 'The WhatsApp message to schedule'],
                    'send_at' => ['type' => 'string', 'description' => 'When to send (ISO 8601 datetime, e.g. 2026-03-15T08:00:00)'],
                ],
                'required' => ['to', 'message', 'send_at'],
            ],
        ],
        [
            'name' => 'delete_expense',
            'description' => 'Delete an expense record by its ID. Use when user says they made a mistake or wants to remove a recorded expense.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'expense_id' => ['type' => 'integer', 'description' => 'The expense ID to delete'],
                ],
                'required' => ['expense_id'],
            ],
        ],
        [
            'name' => 'list_scheduled',
            'description' => 'List all pending scheduled actions (reminders, messages, etc). Shows what is scheduled and when.',
            'input_schema' => [
                'type' => 'object',
                'properties' => (object)[],
                'required' => [],
            ],
        ],
        [
            'name' => 'cancel_scheduled',
            'description' => 'Cancel a pending scheduled action (reminder, message, etc) by its ID.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'scheduled_id' => ['type' => 'integer', 'description' => 'The scheduled action ID to cancel'],
                ],
                'required' => ['scheduled_id'],
            ],
        ],
        // ─── NEW TOOLS: Communication ───
        [
            'name' => 'send_whatsapp_image',
            'description' => 'Envia uma imagem via WhatsApp com legenda opcional. A imagem deve ser uma URL publica acessivel.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'to' => ['type' => 'string', 'description' => 'Phone number with country code (e.g. +5511999998888)'],
                    'image_url' => ['type' => 'string', 'description' => 'Public URL of the image to send'],
                    'caption' => ['type' => 'string', 'description' => 'Caption/legend for the image (optional)', 'default' => ''],
                ],
                'required' => ['to', 'image_url'],
            ],
        ],
        [
            'name' => 'send_whatsapp_audio',
            'description' => 'Envia uma mensagem de audio via WhatsApp. O audio deve ser uma URL publica (MP3, OGG, etc).',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'to' => ['type' => 'string', 'description' => 'Phone number with country code (e.g. +5511999998888)'],
                    'audio_url' => ['type' => 'string', 'description' => 'Public URL of the audio file to send (MP3, OGG, WAV)'],
                ],
                'required' => ['to', 'audio_url'],
            ],
        ],
        [
            'name' => 'send_email_html',
            'description' => 'Envia email com formatacao HTML rica (negrito, italico, listas, tabelas, cores). Use quando o usuario pedir email bonito/formatado.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'to' => ['type' => 'string', 'description' => 'Recipient email address'],
                    'subject' => ['type' => 'string', 'description' => 'Email subject'],
                    'html_body' => ['type' => 'string', 'description' => 'Email body in HTML format'],
                    'text_body' => ['type' => 'string', 'description' => 'Plain text fallback (optional)', 'default' => ''],
                ],
                'required' => ['to', 'subject', 'html_body'],
            ],
        ],
        [
            'name' => 'forward_email',
            'description' => 'Encaminha um email para outra pessoa. O email original eh incluido no corpo.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'uid' => ['type' => 'integer', 'description' => 'UID of the email to forward'],
                    'to' => ['type' => 'string', 'description' => 'Recipient email to forward to'],
                    'folder' => ['type' => 'string', 'description' => 'Folder where the email is', 'default' => 'INBOX'],
                    'comment' => ['type' => 'string', 'description' => 'Optional comment to add above the forwarded email', 'default' => ''],
                ],
                'required' => ['uid', 'to'],
            ],
        ],
        // ─── NEW TOOLS: Organization ───
        [
            'name' => 'create_task',
            'description' => 'Cria uma tarefa (to-do) com data de vencimento, prioridade e categoria. Use quando o usuario mencionar algo que precisa fazer.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'title' => ['type' => 'string', 'description' => 'Task title/description'],
                    'description' => ['type' => 'string', 'description' => 'Detailed description (optional)', 'default' => ''],
                    'due_date' => ['type' => 'string', 'description' => 'Due date in YYYY-MM-DD format (optional)'],
                    'priority' => ['type' => 'string', 'enum' => ['high', 'medium', 'low'], 'description' => 'Priority level', 'default' => 'medium'],
                    'category' => ['type' => 'string', 'description' => 'Category: work, personal, health, finance, study, home, errands, general', 'default' => 'general'],
                    'assignee' => ['type' => 'string', 'description' => 'Who should do this task (email or name, optional)', 'default' => ''],
                ],
                'required' => ['title'],
            ],
        ],
        [
            'name' => 'list_tasks',
            'description' => 'Lista tarefas pendentes. Pode filtrar por prioridade, categoria ou status.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'status' => ['type' => 'string', 'enum' => ['pending', 'completed', 'all'], 'description' => 'Filter by status', 'default' => 'pending'],
                    'priority' => ['type' => 'string', 'description' => 'Filter by priority (optional)'],
                    'category' => ['type' => 'string', 'description' => 'Filter by category (optional)'],
                    'limit' => ['type' => 'integer', 'description' => 'Max tasks to return', 'default' => 20],
                ],
                'required' => [],
            ],
        ],
        [
            'name' => 'complete_task',
            'description' => 'Marca uma tarefa como concluida.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'task_id' => ['type' => 'integer', 'description' => 'Task ID to complete'],
                ],
                'required' => ['task_id'],
            ],
        ],
        [
            'name' => 'create_shopping_list',
            'description' => 'Cria ou adiciona itens a uma lista de compras. Se ja existir uma lista ativa, adiciona os itens nela.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'items' => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => 'List of items to add'],
                    'list_name' => ['type' => 'string', 'description' => 'Shopping list name (default: Lista de Compras)', 'default' => 'Lista de Compras'],
                ],
                'required' => ['items'],
            ],
        ],
        [
            'name' => 'set_alarm',
            'description' => 'Define um alarme que envia notificacao push + WhatsApp + ligacao no horario definido. Mais agressivo que um lembrete normal.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'time' => ['type' => 'string', 'description' => 'Alarm time in ISO 8601 (e.g. 2026-03-21T07:00:00)'],
                    'label' => ['type' => 'string', 'description' => 'Alarm label (e.g. Acordar, Reuniao)'],
                    'phone' => ['type' => 'string', 'description' => 'Phone number for call/WhatsApp (optional, uses saved number)'],
                ],
                'required' => ['time', 'label'],
            ],
        ],
        [
            'name' => 'create_routine',
            'description' => 'Cria uma rotina diaria com lembretes automaticos para cada passo. Ex: rotina matinal (acordar, exercicio, banho, cafe).',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'name' => ['type' => 'string', 'description' => 'Routine name (e.g. Rotina Matinal, Rotina Noturna)'],
                    'steps' => ['type' => 'array', 'items' => ['type' => 'object', 'properties' => ['time' => ['type' => 'string'], 'action' => ['type' => 'string']]], 'description' => 'Array of steps with time (HH:MM) and action description'],
                    'days' => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => 'Days of week: mon,tue,wed,thu,fri,sat,sun', 'default' => ['mon','tue','wed','thu','fri','sat','sun']],
                ],
                'required' => ['name', 'steps'],
            ],
        ],
        // ─── NEW TOOLS: Financial ───
        [
            'name' => 'currency_convert',
            'description' => 'Converte entre moedas usando taxas de cambio atualizadas. Suporta BRL, USD, EUR, GBP, JPY, etc.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'amount' => ['type' => 'number', 'description' => 'Amount to convert'],
                    'from' => ['type' => 'string', 'description' => 'Source currency code (e.g. USD, BRL, EUR)'],
                    'to' => ['type' => 'string', 'description' => 'Target currency code (e.g. BRL, USD, EUR)'],
                ],
                'required' => ['amount', 'from', 'to'],
            ],
        ],
        [
            'name' => 'split_bill',
            'description' => 'Divide uma conta entre pessoas, calcula gorjeta e valor por pessoa.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'total' => ['type' => 'number', 'description' => 'Total bill amount'],
                    'people' => ['type' => 'integer', 'description' => 'Number of people splitting'],
                    'tip_percent' => ['type' => 'number', 'description' => 'Tip percentage (default 10)', 'default' => 10],
                    'currency' => ['type' => 'string', 'description' => 'Currency symbol (default R$)', 'default' => 'R$'],
                ],
                'required' => ['total', 'people'],
            ],
        ],
        [
            'name' => 'budget_create',
            'description' => 'Cria orcamento mensal com categorias e limites de gastos.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'month' => ['type' => 'string', 'description' => 'Month in YYYY-MM format'],
                    'categories' => ['type' => 'array', 'items' => ['type' => 'object', 'properties' => ['name' => ['type' => 'string'], 'amount' => ['type' => 'number']]], 'description' => 'Array of {name, amount} for each budget category'],
                ],
                'required' => ['month', 'categories'],
            ],
        ],
        [
            'name' => 'budget_check',
            'description' => 'Verifica gastos vs orcamento do mes. Mostra quanto ja gastou em cada categoria e quanto falta.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'month' => ['type' => 'string', 'description' => 'Month in YYYY-MM format (default: current month)'],
                ],
                'required' => [],
            ],
        ],
        // ─── NEW TOOLS: Knowledge ───
        [
            'name' => 'weather',
            'description' => 'Consulta clima atual e previsao do tempo para uma cidade.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'city' => ['type' => 'string', 'description' => 'City name (e.g. Sao Paulo, Rio de Janeiro, New York)'],
                ],
                'required' => ['city'],
            ],
        ],
        [
            'name' => 'news',
            'description' => 'Busca as ultimas noticias/manchetes. Pode filtrar por tema.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'topic' => ['type' => 'string', 'description' => 'Topic to search (optional)', 'default' => ''],
                    'limit' => ['type' => 'integer', 'description' => 'Number of headlines', 'default' => 10],
                ],
                'required' => [],
            ],
        ],
        [
            'name' => 'define_word',
            'description' => 'Define uma palavra, mostra significado, sinonimos e exemplos.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'word' => ['type' => 'string', 'description' => 'Word to define'],
                    'language' => ['type' => 'string', 'description' => 'Language (pt, en, es)', 'default' => 'pt'],
                ],
                'required' => ['word'],
            ],
        ],
        [
            'name' => 'random_fact',
            'description' => 'Retorna um fato interessante e aleatorio.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'topic' => ['type' => 'string', 'description' => 'Topic for the fact (optional)', 'default' => ''],
                ],
                'required' => [],
            ],
        ],
        [
            'name' => 'motivational_quote',
            'description' => 'Retorna uma citacao motivacional inspiradora.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'theme' => ['type' => 'string', 'description' => 'Theme (optional)', 'default' => ''],
                ],
                'required' => [],
            ],
        ],
        [
            'name' => 'joke',
            'description' => 'Conta uma piada. Pode ser sobre um tema especifico.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'topic' => ['type' => 'string', 'description' => 'Topic for the joke (optional)', 'default' => ''],
                    'style' => ['type' => 'string', 'description' => 'Style: trocadilho, tiozao, inteligente, nerd', 'default' => ''],
                ],
                'required' => [],
            ],
        ],
        // ─── NEW TOOLS: Health & Wellness ───
        [
            'name' => 'water_reminder',
            'description' => 'Configura lembretes recorrentes para beber agua a cada 2 horas.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'start_hour' => ['type' => 'integer', 'description' => 'Start hour (default 8)', 'default' => 8],
                    'end_hour' => ['type' => 'integer', 'description' => 'End hour (default 22)', 'default' => 22],
                    'interval_hours' => ['type' => 'number', 'description' => 'Hours between reminders (default 2)', 'default' => 2],
                    'phone' => ['type' => 'string', 'description' => 'Phone for delivery (optional)'],
                ],
                'required' => [],
            ],
        ],
        [
            'name' => 'medication_reminder',
            'description' => 'Configura lembrete de medicamento com horarios especificos.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'medication' => ['type' => 'string', 'description' => 'Medication name'],
                    'times' => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => 'Times to take (e.g. ["08:00", "14:00", "20:00"])'],
                    'days' => ['type' => 'integer', 'description' => 'Number of days (default 7)', 'default' => 7],
                    'phone' => ['type' => 'string', 'description' => 'Phone for delivery (optional)'],
                ],
                'required' => ['medication', 'times'],
            ],
        ],
        [
            'name' => 'sleep_log',
            'description' => 'Registra horas de sono para acompanhar qualidade ao longo do tempo.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'hours' => ['type' => 'number', 'description' => 'Hours slept (e.g. 7.5)'],
                    'quality' => ['type' => 'string', 'enum' => ['great', 'good', 'ok', 'bad', 'terrible'], 'description' => 'Sleep quality', 'default' => 'ok'],
                    'notes' => ['type' => 'string', 'description' => 'Additional notes', 'default' => ''],
                    'date' => ['type' => 'string', 'description' => 'Date YYYY-MM-DD (default today)'],
                ],
                'required' => ['hours'],
            ],
        ],
        [
            'name' => 'mood_log',
            'description' => 'Registra humor/estado emocional para acompanhar bem-estar.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'mood' => ['type' => 'string', 'enum' => ['amazing', 'happy', 'calm', 'neutral', 'anxious', 'sad', 'angry', 'stressed', 'tired', 'grateful'], 'description' => 'Current mood'],
                    'notes' => ['type' => 'string', 'description' => 'What is causing this mood', 'default' => ''],
                    'energy' => ['type' => 'integer', 'description' => 'Energy level 1-10 (optional)'],
                ],
                'required' => ['mood'],
            ],
        ],
        // ─── NEW TOOLS: Social ───
        [
            'name' => 'birthday_list',
            'description' => 'Lista aniversarios proximos baseado nos contatos e memorias.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'days_ahead' => ['type' => 'integer', 'description' => 'Days ahead to look (default 30)', 'default' => 30],
                ],
                'required' => [],
            ],
        ],
        [
            'name' => 'gift_suggestion',
            'description' => 'Sugere presentes baseado nos interesses da pessoa.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'person' => ['type' => 'string', 'description' => 'Person name'],
                    'budget' => ['type' => 'number', 'description' => 'Max budget in BRL (optional)'],
                    'occasion' => ['type' => 'string', 'description' => 'Occasion', 'default' => 'general'],
                ],
                'required' => ['person'],
            ],
        ],
        [
            'name' => 'compose_message',
            'description' => 'Ajuda a compor/escrever uma mensagem no tom certo.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'context' => ['type' => 'string', 'description' => 'What the message is about and who its for'],
                    'tone' => ['type' => 'string', 'enum' => ['formal', 'informal', 'romantic', 'business', 'apologetic', 'congratulatory', 'funny'], 'description' => 'Tone of the message', 'default' => 'informal'],
                    'length' => ['type' => 'string', 'enum' => ['short', 'medium', 'long'], 'description' => 'Message length', 'default' => 'medium'],
                ],
                'required' => ['context'],
            ],
        ],
        // ─── NEW TOOLS: File & Document (extra) ───
        [
            'name' => 'list_recent_files',
            'description' => 'Lista os arquivos mais recentemente modificados no Drive.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'limit' => ['type' => 'integer', 'description' => 'Max files to return (default 15)', 'default' => 15],
                    'file_type' => ['type' => 'string', 'enum' => ['photo', 'video', 'document', 'audio', 'archive', 'all'], 'description' => 'Filter by type', 'default' => 'all'],
                ],
                'required' => [],
            ],
        ],
        [
            'name' => 'search_files',
            'description' => 'Busca arquivos por nome ou tipo no Drive.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'query' => ['type' => 'string', 'description' => 'Search query (filename)'],
                    'file_type' => ['type' => 'string', 'enum' => ['photo', 'video', 'document', 'audio', 'archive', 'all'], 'description' => 'Filter by type', 'default' => 'all'],
                    'limit' => ['type' => 'integer', 'description' => 'Max results', 'default' => 20],
                ],
                'required' => ['query'],
            ],
        ],
        // ─── NEW TOOLS: Smart/AI ───
        [
            'name' => 'summarize_text',
            'description' => 'Resume qualquer texto longo em pontos-chave concisos.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'text' => ['type' => 'string', 'description' => 'The long text to summarize'],
                    'style' => ['type' => 'string', 'enum' => ['bullets', 'paragraph', 'one_line'], 'description' => 'Summary style', 'default' => 'bullets'],
                    'max_points' => ['type' => 'integer', 'description' => 'Max bullet points', 'default' => 5],
                ],
                'required' => ['text'],
            ],
        ],
        [
            'name' => 'rewrite_text',
            'description' => 'Reescreve um texto em tom diferente.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'text' => ['type' => 'string', 'description' => 'Text to rewrite'],
                    'tone' => ['type' => 'string', 'enum' => ['formal', 'casual', 'professional', 'friendly', 'academic', 'simple', 'persuasive'], 'description' => 'Target tone'],
                    'language' => ['type' => 'string', 'description' => 'Output language (default: same as input)', 'default' => ''],
                ],
                'required' => ['text', 'tone'],
            ],
        ],
        [
            'name' => 'brainstorm',
            'description' => 'Gera ideias criativas sobre um tema.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'topic' => ['type' => 'string', 'description' => 'Topic to brainstorm about'],
                    'num_ideas' => ['type' => 'integer', 'description' => 'Number of ideas (default 7)', 'default' => 7],
                    'context' => ['type' => 'string', 'description' => 'Additional context (optional)', 'default' => ''],
                ],
                'required' => ['topic'],
            ],
        ],
        [
            'name' => 'pros_cons',
            'description' => 'Cria lista de pros e contras para uma decisao.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'decision' => ['type' => 'string', 'description' => 'The decision to evaluate'],
                    'context' => ['type' => 'string', 'description' => 'Additional context (optional)', 'default' => ''],
                ],
                'required' => ['decision'],
            ],
        ],
        [
            'name' => 'email_template',
            'description' => 'Gera templates de email prontos para usar.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'type' => ['type' => 'string', 'enum' => ['business', 'personal', 'complaint', 'thank_you', 'introduction', 'follow_up', 'invitation', 'apology', 'resignation', 'cover_letter'], 'description' => 'Template type'],
                    'context' => ['type' => 'string', 'description' => 'Specific context for the email'],
                    'language' => ['type' => 'string', 'description' => 'Language', 'default' => 'pt-BR'],
                ],
                'required' => ['type', 'context'],
            ],
        ],
        [
            'name' => 'study_flashcards',
            'description' => 'Cria flashcards para estudo sobre um tema.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'topic' => ['type' => 'string', 'description' => 'Topic to create flashcards about'],
                    'num_cards' => ['type' => 'integer', 'description' => 'Number of flashcards (default 10)', 'default' => 10],
                    'difficulty' => ['type' => 'string', 'enum' => ['beginner', 'intermediate', 'advanced'], 'description' => 'Difficulty level', 'default' => 'intermediate'],
                ],
                'required' => ['topic'],
            ],
        ],
        [
            'name' => 'recipe_suggest',
            'description' => 'Sugere receita baseada nos ingredientes disponiveis.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'ingredients' => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => 'Available ingredients'],
                    'cuisine' => ['type' => 'string', 'description' => 'Cuisine type (optional)', 'default' => ''],
                    'dietary' => ['type' => 'string', 'description' => 'Dietary restrictions (optional)', 'default' => ''],
                    'meal_type' => ['type' => 'string', 'enum' => ['breakfast', 'lunch', 'dinner', 'snack', 'dessert', 'any'], 'description' => 'Meal type', 'default' => 'any'],
                ],
                'required' => ['ingredients'],
            ],
        ],
    ];
}

// ─── Twilio SMS ───
function oneSendSms($to, $message) {
    // Load Twilio credentials from env
    $sid = '';
    $token = '';
    $from = '';
    if (file_exists('/etc/mail-api.env')) {
        foreach (file('/etc/mail-api.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            if (strpos($line, 'TWILIO_SID=') === 0) $sid = substr($line, strlen('TWILIO_SID='));
            if (strpos($line, 'TWILIO_TOKEN=') === 0) $token = substr($line, strlen('TWILIO_TOKEN='));
            if (strpos($line, 'TWILIO_FROM=') === 0) $from = substr($line, strlen('TWILIO_FROM='));
        }
    }
    if (!$sid || !$token || !$from) {
        return ['error' => 'Twilio not configured on server'];
    }

    // Sanitize phone number
    $to = preg_replace('/[^+0-9]/', '', $to);
    if (!preg_match('/^\+[1-9]\d{6,14}$/', $to)) {
        return ['error' => 'Invalid phone number format. Use +55XXXXXXXXXXX'];
    }

    // Truncate message to SMS limit
    $message = mb_substr($message, 0, 1600);

    $url = "https://api.twilio.com/2010-04-01/Accounts/$sid/Messages.json";
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => http_build_query([
            'To' => $to,
            'From' => $from,
            'Body' => $message,
        ]),
        CURLOPT_USERPWD => "$sid:$token",
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
    ]);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($curlErr) {
        error_log("[One SMS] Curl error: $curlErr");
        return ['error' => 'Failed to connect to SMS service'];
    }

    $data = json_decode($response, true);
    if ($httpCode >= 200 && $httpCode < 300 && isset($data['sid'])) {
        return ['success' => true, 'message' => "SMS enviado para $to", 'sid' => $data['sid']];
    } else {
        $errMsg = $data['message'] ?? "HTTP $httpCode";
        error_log("[One SMS] Error: $errMsg");
        return ['error' => "SMS failed: $errMsg"];
    }
}

// ─── Twilio WhatsApp ───
function oneSendWhatsapp($to, $message, $templateSid = null, $templateVars = null) {
    $sid = '';
    $token = '';
    $from = '';
    if (file_exists('/etc/mail-api.env')) {
        foreach (file('/etc/mail-api.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            if (strpos($line, '#') === 0) continue;
            if (strpos($line, 'TWILIO_ACCOUNT_SID=') === 0) $sid = substr($line, strlen('TWILIO_ACCOUNT_SID='));
            if (strpos($line, 'TWILIO_AUTH_TOKEN=') === 0) $token = substr($line, strlen('TWILIO_AUTH_TOKEN='));
            if (strpos($line, 'TWILIO_WHATSAPP_NUMBER=') === 0) $from = substr($line, strlen('TWILIO_WHATSAPP_NUMBER='));
        }
    }
    if (!$sid || !$token || !$from) {
        return ['error' => 'Twilio WhatsApp not configured on server'];
    }

    // Sanitize phone number
    $to = preg_replace('/[^+0-9]/', '', $to);
    if (!str_starts_with($to, '+')) $to = '+55' . $to;
    if (!preg_match('/^\+[1-9]\d{6,14}$/', $to)) {
        return ['error' => 'Invalid phone number format. Use +55XXXXXXXXXXX'];
    }
    $toWhatsapp = 'whatsapp:' . $to;

    // If explicit template requested, use it. Otherwise try freeform first (works within 24h window)
    if ($templateSid) {
        $postData = [
            'To' => $toWhatsapp,
            'From' => $from,
            'ContentSid' => $templateSid,
            'ContentVariables' => json_encode($templateVars ?: ['1' => $message]),
        ];
    } else {
        // Try freeform message first (cheaper, more flexible)
        $postData = [
            'To' => $toWhatsapp,
            'From' => $from,
            'Body' => $message,
        ];
    }
    $triedFreeform = !$templateSid;

    $url = "https://api.twilio.com/2010-04-01/Accounts/$sid/Messages.json";
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => http_build_query($postData),
        CURLOPT_USERPWD => "$sid:$token",
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
    ]);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($curlErr) {
        error_log("[One WhatsApp] Curl error: $curlErr");
        return ['error' => 'Failed to connect to WhatsApp service'];
    }

    $data = json_decode($response, true);
    if ($httpCode >= 200 && $httpCode < 300 && isset($data['sid'])) {
        return ['success' => true, 'message' => "WhatsApp enviado para $to", 'sid' => $data['sid']];
    }

    // If freeform failed (likely outside 24h window), fallback to template
    if ($triedFreeform) {
        $fallbackSid = '';
        foreach (file('/etc/mail-api.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $envLine) {
            if (strpos($envLine, '#') === 0) continue;
            if (strpos($envLine, 'WA_TPL_REMINDER=') === 0) $fallbackSid = trim(substr($envLine, strlen('WA_TPL_REMINDER=')));
        }
        if ($fallbackSid) {
            error_log("[One WhatsApp] Freeform failed, trying template fallback");
            $ch2 = curl_init($url);
            curl_setopt_array($ch2, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => http_build_query([
                    'To' => $toWhatsapp,
                    'From' => $from,
                    'ContentSid' => $fallbackSid,
                    'ContentVariables' => json_encode(['1' => $message]),
                ]),
                CURLOPT_USERPWD => "$sid:$token",
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 15,
            ]);
            $response2 = curl_exec($ch2);
            $httpCode2 = curl_getinfo($ch2, CURLINFO_HTTP_CODE);
            curl_close($ch2);
            $data2 = json_decode($response2, true);
            if ($httpCode2 >= 200 && $httpCode2 < 300 && isset($data2['sid'])) {
                return ['success' => true, 'message' => "WhatsApp enviado para $to (via template)", 'sid' => $data2['sid']];
            }
        }
    }

    $errMsg = $data['message'] ?? "HTTP $httpCode";
    error_log("[One WhatsApp] Error: $errMsg");
    return ['error' => "WhatsApp failed: $errMsg"];
}

// ─── WhatsApp Template Helpers ───
function _loadWaTemplateSid($name) {
    $envMap = [
        'reminder' => 'WA_TPL_REMINDER',
        'scheduled' => 'WA_TPL_SCHEDULED',
        'payment_failed' => 'WA_TPL_PAYMENT_FAILED',
        'welcome' => 'WA_TPL_WELCOME',
        'storage_warning' => 'WA_TPL_STORAGE_WARNING',
    ];
    $envKey = $envMap[$name] ?? '';
    if (!$envKey) return null;
    foreach (file('/etc/mail-api.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        if (strpos($line, '#') === 0) continue;
        if (strpos($line, $envKey . '=') === 0) return trim(substr($line, strlen($envKey) + 1));
    }
    return null;
}

function oneSendWhatsappTemplate($to, $templateName, $vars = []) {
    $tplSid = _loadWaTemplateSid($templateName);
    if (!$tplSid) return oneSendWhatsapp($to, implode(' ', $vars)); // fallback to free-form
    $templateVars = [];
    $i = 1;
    foreach ($vars as $v) { $templateVars[(string)$i] = $v; $i++; }
    return oneSendWhatsapp($to, '', $tplSid, $templateVars);
}

// ─── Z-API WhatsApp (for US numbers) ───
function oneSendZapiWhatsapp($to, $body) {
    $instanceId = '';
    $zapiToken = '';
    if (file_exists('/etc/mail-api.env')) {
        foreach (file('/etc/mail-api.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            if (strpos($line, '#') === 0) continue;
            if (strpos($line, 'ZAPI_INSTANCE_ID=') === 0) $instanceId = trim(substr($line, strlen('ZAPI_INSTANCE_ID=')));
            if (strpos($line, 'ZAPI_TOKEN=') === 0) $zapiToken = trim(substr($line, strlen('ZAPI_TOKEN=')));
        }
    }
    if (!$instanceId || !$zapiToken) {
        return ['error' => 'Z-API not configured on server'];
    }

    // Z-API expects phone without + prefix, digits only
    $phone = preg_replace('/[^0-9]/', '', $to);
    if (strlen($phone) < 10) {
        return ['error' => 'Invalid phone number for Z-API'];
    }

    $url = "https://api.z-api.io/instances/{$instanceId}/token/{$zapiToken}/send-text";
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode(['phone' => $phone, 'message' => $body]),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Client-Token: ' . trim(getenv('ZAPI_CLIENT_TOKEN') ?: 'F4d9cb10a1a5c4d34af5bf61ec6f9f301S')],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
    ]);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($curlErr) {
        error_log("[One Z-API] Curl error: $curlErr");
        return ['error' => 'Failed to connect to Z-API'];
    }

    $data = json_decode($response, true);
    if ($httpCode >= 200 && $httpCode < 300 && !empty($data['zapiMessageId'])) {
        return ['success' => true, 'message' => "WhatsApp enviado via Z-API para $to", 'messageId' => $data['zapiMessageId']];
    }

    $errMsg = $data['message'] ?? $data['error'] ?? "HTTP $httpCode";
    error_log("[One Z-API] Error: $errMsg");
    return ['error' => "Z-API failed: $errMsg"];
}

// ─── ElevenLabs TTS for Call Audio ───
function oneGenerateCallAudio($text, $language = 'pt-BR') {
    $apiKey = '';
    if (file_exists('/etc/mail-api.env')) {
        foreach (file('/etc/mail-api.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            if (strpos($line, '#') === 0) continue;
            if (strpos($line, 'ELEVENLABS_API_KEY=') === 0) { $apiKey = substr($line, strlen('ELEVENLABS_API_KEY=')); break; }
        }
    }
    if (!$apiKey) return null;

    $voiceId = '21m00Tcm4TlvDq8ikWAM'; // Rachel - multilingual
    $ch = curl_init("https://api.elevenlabs.io/v1/text-to-speech/$voiceId");
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode([
            'text' => $text,
            'model_id' => 'eleven_turbo_v2_5',
            'voice_settings' => ['stability' => 0.5, 'similarity_boost' => 0.75, 'style' => 0.3],
        ]),
        CURLOPT_HTTPHEADER => ['xi-api-key: ' . $apiKey, 'Content-Type: application/json', 'Accept: audio/mpeg'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
    ]);
    $audio = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($curlErr) {
        error_log("[ElevenLabs] Curl error: $curlErr");
        return null;
    }
    if ($code !== 200 || strlen($audio) < 1000) {
        error_log("[ElevenLabs] HTTP $code, audio size: " . strlen($audio));
        return null;
    }

    $filename = 'call-' . bin2hex(random_bytes(8)) . '.mp3';
    $path = '/var/www/mail/data/' . $filename;
    file_put_contents($path, $audio, LOCK_EX);

    // Clean up old call audio files (older than 1 hour)
    foreach (glob('/var/www/mail/data/call-*.mp3') as $f) {
        if (filemtime($f) < time() - 3600) @unlink($f);
    }

    return 'https://chatyy.com.br/data/' . $filename;
}

// ─── Twilio Voice Call ───
function oneMakeCall($to, $message) {
    $sid = '';
    $token = '';
    $from = '';
    if (file_exists('/etc/mail-api.env')) {
        foreach (file('/etc/mail-api.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            if (strpos($line, '#') === 0) continue;
            if (strpos($line, 'TWILIO_ACCOUNT_SID=') === 0) $sid = substr($line, strlen('TWILIO_ACCOUNT_SID='));
            if (strpos($line, 'TWILIO_AUTH_TOKEN=') === 0) $token = substr($line, strlen('TWILIO_AUTH_TOKEN='));
            if (strpos($line, 'TWILIO_PHONE_NUMBER=') === 0) $from = substr($line, strlen('TWILIO_PHONE_NUMBER='));
        }
    }
    if (!$sid || !$token || !$from) {
        return ['error' => 'Twilio voice not configured on server'];
    }

    // Sanitize phone number
    $to = preg_replace('/[^+0-9]/', '', $to);
    if (!str_starts_with($to, '+')) $to = '+55' . $to;
    if (!preg_match('/^\+[1-9]\d{6,14}$/', $to)) {
        return ['error' => 'Invalid phone number format. Use +55XXXXXXXXXXX'];
    }

    // Build full call script
    $fullText = "Ola! Aqui e a One, sua assistente pessoal do Chatyy. "
        . "Estou te ligando para lembrar: $message. "
        . "Repetindo: $message. "
        . "Tenha um otimo dia! Ate mais.";

    // Try ElevenLabs first for natural voice
    $audioUrl = oneGenerateCallAudio($fullText);

    if ($audioUrl) {
        $twiml = '<Response><Pause length="1"/><Play>' . htmlspecialchars($audioUrl, ENT_XML1 | ENT_QUOTES, 'UTF-8') . '</Play></Response>';
    } else {
        // Fallback to Polly
        $escapedMsg = htmlspecialchars($message, ENT_XML1 | ENT_QUOTES, 'UTF-8');
        $twiml = '<Response>'
            . '<Pause length="1"/>'
            . '<Say language="pt-BR" voice="Polly.Vitoria-Neural">Ola! Aqui e a One, sua assistente pessoal do Chatyy.</Say>'
            . '<Pause length="1"/>'
            . '<Say language="pt-BR" voice="Polly.Vitoria-Neural">Estou te ligando para lembrar: ' . $escapedMsg . '</Say>'
            . '<Pause length="2"/>'
            . '<Say language="pt-BR" voice="Polly.Vitoria-Neural">Repetindo: ' . $escapedMsg . '</Say>'
            . '<Pause length="1"/>'
            . '<Say language="pt-BR" voice="Polly.Vitoria-Neural">Tenha um otimo dia! Ate mais.</Say>'
            . '</Response>';
    }

    $url = "https://api.twilio.com/2010-04-01/Accounts/$sid/Calls.json";
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => http_build_query([
            'To' => $to,
            'From' => $from,
            'Twiml' => $twiml,
        ]),
        CURLOPT_USERPWD => "$sid:$token",
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
    ]);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($curlErr) {
        error_log("[One Call] Curl error: $curlErr");
        return ['error' => 'Failed to connect to call service'];
    }

    $data = json_decode($response, true);
    if ($httpCode >= 200 && $httpCode < 300 && isset($data['sid'])) {
        return ['success' => true, 'message' => "Ligacao iniciada para $to", 'sid' => $data['sid']];
    } else {
        $errMsg = $data['message'] ?? "HTTP $httpCode";
        error_log("[One Call] Error: $errMsg");
        return ['error' => "Call failed: $errMsg"];
    }
}

// ─── Tool Execution ───
function oneSanitizeFolder($folder) {
    // Prevent IMAP folder injection
    $folder = preg_replace('/[^a-zA-Z0-9_.\-\/]/', '', $folder);
    $folder = str_replace('..', '', $folder);
    return $folder ?: 'INBOX';
}

function oneExecuteTool($toolName, $toolInput, $auth) {
    $email = $auth['email'];
    $password = $auth['password'];
    $userTimezone = $GLOBALS['__one_user_tz'] ?? 'America/Sao_Paulo';
    date_default_timezone_set($userTimezone);

    switch ($toolName) {
        case 'list_recent_emails': {
            $folder = oneSanitizeFolder($toolInput['folder'] ?? 'INBOX');
            $limit = min($toolInput['limit'] ?? 10, 30);
            $imap = @imap_open("{localhost:993/imap/ssl/novalidate-cert}$folder", $email, $password);
            if (!$imap) return ['error' => 'Could not connect to mailbox'];
            $info = imap_check($imap);
            $total = $info->Nmsgs;
            $start = max(1, $total - $limit + 1);
            $emails = [];
            for ($i = $total; $i >= $start; $i--) {
                $header = imap_headerinfo($imap, $i);
                if (!$header) continue;
                $uid = imap_uid($imap, $i);
                $from = isset($header->from[0]) ? (($header->from[0]->personal ?? '') ?: ($header->from[0]->mailbox . '@' . $header->from[0]->host)) : '';
                $fromEmail = isset($header->from[0]) ? ($header->from[0]->mailbox . '@' . $header->from[0]->host) : '';
                $subject = isset($header->subject) ? imap_utf8($header->subject) : '(sem assunto)';
                $date = isset($header->date) ? date('Y-m-d H:i', strtotime($header->date)) : '';
                $seen = isset($header->Unseen) ? ($header->Unseen !== 'U') : true;
                $emails[] = [
                    'uid' => $uid,
                    'from' => $from,
                    'from_email' => $fromEmail,
                    'subject' => $subject,
                    'date' => $date,
                    'read' => $seen,
                ];
            }
            try { imap_close($imap); } catch (\Throwable $e) {}
            return ['emails' => $emails, 'total' => $total, 'folder' => $folder];
        }

        case 'read_email': {
            $uid = $toolInput['uid'] ?? 0;
            $folder = oneSanitizeFolder($toolInput['folder'] ?? 'INBOX');
            if (!$uid) return ['error' => 'UID required'];
            $imap = @imap_open("{localhost:993/imap/ssl/novalidate-cert}$folder", $email, $password);
            if (!$imap) return ['error' => 'Could not connect'];
            $msgno = imap_msgno($imap, $uid);
            if (!$msgno) { try { imap_close($imap); } catch (\Throwable $e) {} return ['error' => 'Email not found']; }
            $header = imap_headerinfo($imap, $msgno);
            $body = imap_fetchbody($imap, $msgno, '1');
            $encoding = null;
            $struct = imap_fetchstructure($imap, $msgno);
            if ($struct && isset($struct->parts[0])) {
                $encoding = $struct->parts[0]->encoding;
            } elseif ($struct) {
                $encoding = $struct->encoding;
            }
            if ($encoding === 3) $body = base64_decode($body);
            elseif ($encoding === 4) $body = quoted_printable_decode($body);
            $body = strip_tags($body);
            $body = mb_substr(trim($body), 0, 3000);
            $from = isset($header->from[0]) ? (($header->from[0]->personal ?? '') ?: ($header->from[0]->mailbox . '@' . $header->from[0]->host)) : '';
            $subject = isset($header->subject) ? imap_utf8($header->subject) : '';
            $date = isset($header->date) ? date('Y-m-d H:i', strtotime($header->date)) : '';
            $to = isset($header->to[0]) ? ($header->to[0]->mailbox . '@' . ($header->to[0]->host ?? '')) : '';
            try { imap_close($imap); } catch (\Throwable $e) {}
            return ['uid' => $uid, 'from' => $from, 'to' => $to, 'subject' => $subject, 'date' => $date, 'body' => $body];
        }

        case 'search_emails': {
            $query = $toolInput['query'] ?? '';
            $folder = oneSanitizeFolder($toolInput['folder'] ?? 'INBOX');
            $limit = min($toolInput['limit'] ?? 10, 20);
            if (!$query) return ['error' => 'Query required'];
            $imap = @imap_open("{localhost:993/imap/ssl/novalidate-cert}$folder", $email, $password);
            if (!$imap) return ['error' => 'Could not connect'];
            // Search in subject and from
            $results = imap_search($imap, 'OR SUBJECT "' . addcslashes($query, '"\\') . '" FROM "' . addcslashes($query, '"\\') . '"', SE_UID);
            $emails = [];
            if ($results) {
                $results = array_reverse($results);
                $results = array_slice($results, 0, $limit);
                foreach ($results as $uid) {
                    $msgno = imap_msgno($imap, $uid);
                    if (!$msgno) continue;
                    $header = imap_headerinfo($imap, $msgno);
                    $from = isset($header->from[0]) ? (($header->from[0]->personal ?? '') ?: ($header->from[0]->mailbox . '@' . $header->from[0]->host)) : '';
                    $subject = isset($header->subject) ? imap_utf8($header->subject) : '';
                    $date = isset($header->date) ? date('Y-m-d H:i', strtotime($header->date)) : '';
                    $emails[] = ['uid' => $uid, 'from' => $from, 'subject' => $subject, 'date' => $date];
                }
            }
            try { imap_close($imap); } catch (\Throwable $e) {}
            return ['results' => $emails, 'count' => count($emails), 'query' => $query];
        }

        case 'delete_email': {
            $uid = $toolInput['uid'] ?? 0;
            $folder = oneSanitizeFolder($toolInput['folder'] ?? 'INBOX');
            if (!$uid) return ['error' => 'UID required'];
            $imap = @imap_open("{localhost:993/imap/ssl/novalidate-cert}$folder", $email, $password);
            if (!$imap) return ['error' => 'Could not connect'];
            $result = imap_mail_move($imap, (string)$uid, 'Trash', CP_UID);
            imap_expunge($imap);
            try { imap_close($imap); } catch (\Throwable $e) {}
            return $result ? ['success' => true, 'message' => 'Email movido para Lixeira'] : ['error' => 'Failed to delete'];
        }

        case 'move_email': {
            $uid = $toolInput['uid'] ?? 0;
            $folder = oneSanitizeFolder($toolInput['folder'] ?? 'INBOX');
            $dest = oneSanitizeFolder($toolInput['destination'] ?? '');
            if (!$uid || !$dest) return ['error' => 'UID and destination required'];
            $imap = @imap_open("{localhost:993/imap/ssl/novalidate-cert}$folder", $email, $password);
            if (!$imap) return ['error' => 'Could not connect'];
            $result = imap_mail_move($imap, (string)$uid, $dest, CP_UID);
            imap_expunge($imap);
            try { imap_close($imap); } catch (\Throwable $e) {}
            return $result ? ['success' => true] : ['error' => 'Failed to move'];
        }

        case 'send_email': {
            $to = $toolInput['to'] ?? '';
            $subject = str_replace(["\r", "\n"], '', $toolInput['subject'] ?? '');
            $body = $toolInput['body'] ?? '';
            if (!$to || !$subject) return ['error' => 'Recipient and subject required'];
            $to = str_replace(["\r", "\n"], '', $to); // prevent header injection

            // Build MIME message
            $encodedSubject = preg_match('/[^\x20-\x7E]/', $subject) ? '=?UTF-8?B?' . base64_encode($subject) . '?=' : $subject;
            $mime = "From: {$email}\r\n";
            $mime .= "To: {$to}\r\n";
            $mime .= "Subject: {$encodedSubject}\r\n";
            $mime .= "Date: " . date('r') . "\r\n";
            $mime .= "Message-ID: <" . uniqid('one_', true) . "@" . explode('@', $email)[1] . ">\r\n";
            $mime .= "MIME-Version: 1.0\r\n";
            $mime .= "Content-Type: text/plain; charset=UTF-8\r\n";
            $mime .= "Content-Transfer-Encoding: quoted-printable\r\n";
            $mime .= "X-Mailer: Chatyy One AI/1.0\r\n";
            $mime .= "\r\n";
            $mime .= quoted_printable_encode($body);

            // Send via sendmail (bypasses postscreen)
            $recipients = array_filter(array_map('trim', explode(',', $to)));
            $cmd = '/usr/sbin/sendmail -oi -f ' . escapeshellarg($email);
            foreach ($recipients as $rcpt) {
                if (filter_var($rcpt, FILTER_VALIDATE_EMAIL)) {
                    $cmd .= ' ' . escapeshellarg($rcpt);
                }
            }
            $proc = proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            if (!is_resource($proc)) return ['error' => 'Failed to start sendmail'];

            $len = strlen($mime); $off = 0;
            while ($off < $len) {
                $w = fwrite($pipes[0], substr($mime, $off, 8192));
                if ($w === false) break;
                $off += $w;
            }
            fclose($pipes[0]);
            fclose($pipes[1]);
            $stderr = stream_get_contents($pipes[2]);
            fclose($pipes[2]);
            $exitCode = proc_close($proc);
            $result = ($exitCode === 0);

            // Save to Sent folder
            if ($result) {
                $imap = @imap_open("{localhost:993/imap/ssl/novalidate-cert}INBOX", $email, $password);
                if ($imap) {
                    @imap_append($imap, "{localhost:993/imap/ssl/novalidate-cert}Sent", $mime, "\\Seen");
                    try { @imap_close($imap); } catch (\Throwable $e) {}
                }
            } else {
                error_log("[ONE] sendmail failed: exit={$exitCode} stderr={$stderr}");
            }
            return $result ? ['success' => true, 'message' => "Email enviado para $to"] : ['error' => 'Failed to send: ' . $stderr];
        }

        case 'create_calendar_event': {
            $title = $toolInput['title'] ?? '';
            $startAt = $toolInput['start_at'] ?? '';
            if (!$title || !$startAt) return ['error' => 'Title and start time required'];
            $endAt = $toolInput['end_at'] ?? date('Y-m-d\TH:i:s', strtotime($startAt) + 3600);
            $desc = $toolInput['description'] ?? '';
            $location = $toolInput['location'] ?? '';
            $reminder = $toolInput['reminder_minutes'] ?? 30;

            $calDb = new SQLite3('/var/www/mail/data/calendar.db');
            $calDb->busyTimeout(3000);
            // Get or create default calendar
            $calStmt = $calDb->prepare("SELECT id FROM calendars WHERE user_email=:email LIMIT 1");
            $calStmt->bindValue(':email', $email);
            $cal = $calStmt->execute()->fetchArray(SQLITE3_ASSOC);
            $cal = $cal ? $cal['id'] : null;
            if (!$cal) {
                $calInsert = $calDb->prepare("INSERT INTO calendars (user_email, name, color, created_at, updated_at) VALUES (:email, 'Calendario', '#2563eb', datetime('now'), datetime('now'))");
                $calInsert->bindValue(':email', $email);
                $calInsert->execute();
                $cal = $calDb->lastInsertRowID();
            }
            $stmt = $calDb->prepare("INSERT INTO events (user_email, calendar_id, title, description, location, start_at, end_at, created_at, updated_at) VALUES (:email, :cal, :title, :desc, :loc, :start, :end, datetime('now'), datetime('now'))");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':cal', $cal);
            $stmt->bindValue(':title', $title);
            $stmt->bindValue(':desc', $desc);
            $stmt->bindValue(':loc', $location);
            $stmt->bindValue(':start', $startAt);
            $stmt->bindValue(':end', $endAt);
            $stmt->execute();
            $eventId = $calDb->lastInsertRowID();
            $calDb->close();

            // Schedule reminder
            if ($reminder > 0) {
                $reminderTime = date('Y-m-d\TH:i:s', strtotime($startAt) - ($reminder * 60));
                $db = oneGetDb();
                $stmt2 = $db->prepare("INSERT INTO one_scheduled (user_email, action_type, action_data, trigger_at) VALUES (:email, 'reminder', :data, :trigger)");
                $stmt2->bindValue(':email', $email);
                $stmt2->bindValue(':data', json_encode(['message' => "Lembrete: $title", 'event_id' => $eventId]));
                $stmt2->bindValue(':trigger', $reminderTime);
                $stmt2->execute();
                $db->close();
            }

            return ['success' => true, 'event_id' => $eventId, 'message' => "Evento '$title' criado em " . date('d/m/Y H:i', strtotime($startAt)) . ($reminder > 0 ? ". Lembrete {$reminder}min antes." : '')];
        }

        case 'list_calendar_events': {
            $days = min($toolInput['days'] ?? 7, 30);
            $attendee = trim($toolInput['attendee'] ?? '');
            $calendarFilter = trim($toolInput['calendar'] ?? '');
            $now = date('Y-m-d\TH:i:s');
            $until = date('Y-m-d\TH:i:s', time() + $days * 86400);
            $calDb = new SQLite3('/var/www/mail/data/calendar.db');
            $calDb->busyTimeout(3000);

            $sql = "SELECT e.id, e.title, e.description, e.location, e.start_at, e.end_at, c.name as calendar_name FROM events e LEFT JOIN calendars c ON e.calendar_id = c.id WHERE e.user_email=:email AND e.start_at >= :now AND e.start_at <= :until";
            $params = [':email' => $email, ':now' => $now, ':until' => $until];

            if ($attendee) {
                $sql .= " AND (e.description LIKE :attendee OR e.title LIKE :attendee2)";
                $params[':attendee'] = "%$attendee%";
                $params[':attendee2'] = "%$attendee%";
            }
            if ($calendarFilter) {
                $sql .= " AND c.name LIKE :calname";
                $params[':calname'] = "%$calendarFilter%";
            }
            $sql .= " ORDER BY e.start_at ASC LIMIT 20";

            $stmt = $calDb->prepare($sql);
            foreach ($params as $k => $v) {
                $stmt->bindValue($k, $v);
            }
            $result = $stmt->execute();
            $events = [];
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
                $events[] = $row;
            }
            $calDb->close();
            return ['events' => $events, 'period' => "proximo" . ($days > 1 ? "s {$days} dias" : " dia")];
        }

        case 'create_reminder': {
            $message = $toolInput['message'] ?? '';
            $triggerAt = $toolInput['trigger_at'] ?? '';
            $delivery = $toolInput['delivery'] ?? 'whatsapp';
            $phoneFromTool = $toolInput['phone'] ?? '';
            if (!$message || !$triggerAt) return ['error' => 'Message and trigger time required'];

            // Resolve phone number: tool param → memory
            $phone = '';
            if ($phoneFromTool) {
                // Sanitize and normalize phone from tool call
                $phone = preg_replace('/[^+0-9]/', '', $phoneFromTool);
                if (!str_starts_with($phone, '+')) $phone = '+55' . $phone;

                // Auto-save phone to memory for future use
                $dbSave = oneGetDb();
                $saveKey = str_starts_with($phone, '+1') ? 'phone_number_us' : 'phone_number';
                $saveStmt = $dbSave->prepare("INSERT OR REPLACE INTO one_memory (user_email, category, key, value, updated_at) VALUES (:email, 'contact_info', :key, :val, datetime('now'))");
                $saveStmt->bindValue(':email', $email);
                $saveStmt->bindValue(':key', $saveKey);
                $saveStmt->bindValue(':val', $phone);
                $saveStmt->execute();
                $dbSave->close();
            }

            // If no phone from tool, look up in memory
            if (!$phone && ($delivery === 'call' || $delivery === 'sms' || $delivery === 'whatsapp')) {
                $db = oneGetDb();
                $phoneStmt = $db->prepare("SELECT key, value FROM one_memory WHERE user_email=:email AND category='contact_info' AND key LIKE 'phone%'");
                $phoneStmt->bindValue(':email', $email);
                $phones = [];
                $result = $phoneStmt->execute();
                while ($r = $result->fetchArray(SQLITE3_ASSOC)) {
                    $phones[$r['key']] = $r['value'];
                }
                $db->close();
                if (empty($phones)) {
                    return ['error' => 'Nao tenho o numero de telefone do usuario. Pergunte o numero e salve com remember_preference(category: contact_info, key: phone_number, value: +XXXXXXXXXXX) antes de criar o lembrete.'];
                }
                // Pick the best phone: phone_number (BR) preferred for WhatsApp, phone_number_us for US calls
                $phone = $phones['phone_number'] ?? $phones['phone_number_us'] ?? reset($phones);
            }

            $db = oneGetDb();
            $stmt = $db->prepare("INSERT INTO one_scheduled (user_email, action_type, action_data, trigger_at) VALUES (:email, :type, :data, :trigger)");
            $stmt->bindValue(':email', $email);
            // Map delivery method to action_type for cron processing
            $typeMap = ['call' => 'call_reminder', 'whatsapp' => 'sms_reminder', 'sms' => 'sms_reminder'];
            $stmt->bindValue(':type', $typeMap[$delivery] ?? 'push_reminder');
            // Include phone in action_data so cron uses it directly
            $actionData = ['message' => $message, 'delivery' => $delivery];
            if ($phone) $actionData['phone'] = $phone;
            $stmt->bindValue(':data', json_encode($actionData));
            $stmt->bindValue(':trigger', $triggerAt);
            $stmt->execute();
            $db->close();
            $deliveryLabels = ['call' => 'vou te ligar', 'whatsapp' => 'mando no WhatsApp', 'sms' => 'mando um SMS', 'push' => 'mando uma notificacao push + WhatsApp'];
            $deliveryText = $deliveryLabels[$delivery] ?? 'mando uma notificacao';
            $phoneNote = $phone ? " (para $phone)" : '';
            return ['success' => true, 'message' => "Lembrete criado! $deliveryText$phoneNote em " . date('d/m/Y H:i', strtotime($triggerAt))];
        }

        case 'remember_preference': {
            $category = $toolInput['category'] ?? 'preference';
            $key = $toolInput['key'] ?? '';
            $value = $toolInput['value'] ?? '';
            if (!$key) return ['error' => 'Key required'];
            $db = oneGetDb();
            $stmt = $db->prepare("INSERT OR REPLACE INTO one_memory (user_email, category, key, value, updated_at) VALUES (:email, :cat, :key, :val, datetime('now'))");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':cat', $category);
            $stmt->bindValue(':key', $key);
            $stmt->bindValue(':val', $value);
            $stmt->execute();
            $db->close();
            return ['success' => true, 'message' => 'Anotado! Vou lembrar disso.'];
        }

        case 'get_memories': {
            $category = $toolInput['category'] ?? null;
            $db = oneGetDb();
            if ($category) {
                $stmt = $db->prepare("SELECT category, key, value FROM one_memory WHERE user_email=:email AND category=:cat ORDER BY updated_at DESC LIMIT 50");
                $stmt->bindValue(':email', $email);
                $stmt->bindValue(':cat', $category);
            } else {
                $stmt = $db->prepare("SELECT category, key, value FROM one_memory WHERE user_email=:email ORDER BY updated_at DESC LIMIT 50");
                $stmt->bindValue(':email', $email);
            }
            $result = $stmt->execute();
            $memories = [];
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
                $memories[] = $row;
            }
            $db->close();
            return ['memories' => $memories];
        }

        case 'mark_email_read': {
            $uid = $toolInput['uid'] ?? 0;
            $folder = oneSanitizeFolder($toolInput['folder'] ?? 'INBOX');
            $read = $toolInput['read'] ?? true;
            if (!$uid) return ['error' => 'UID required'];
            $imap = @imap_open("{localhost:993/imap/ssl/novalidate-cert}$folder", $email, $password);
            if (!$imap) return ['error' => 'Could not connect'];
            if ($read) {
                imap_setflag_full($imap, (string)$uid, '\\Seen', ST_UID);
            } else {
                imap_clearflag_full($imap, (string)$uid, '\\Seen', ST_UID);
            }
            try { imap_close($imap); } catch (\Throwable $e) {}
            return ['success' => true, 'message' => $read ? 'Marcado como lido' : 'Marcado como nao lido'];
        }

        case 'summarize_emails': {
            $folder = oneSanitizeFolder($toolInput['folder'] ?? 'INBOX');
            $limit = min($toolInput['limit'] ?? 20, 30);
            // Fast-path: user signed up via phone (password_enc='') or has
            // external email domain (gmail.com etc) — IMAP local nao tem
            // mailbox dele. Sem isso a LLM dizia "problema de conexao" que
            // confundia (foto user 2026-05-05 "ja estava todo pronto").
            if (empty($password)) {
                return ['error' => 'no_imap_account', 'reason' => 'Esta conta nao tem caixa de email Chatyy associada (signup via telefone). Para resumir emails, configure uma conta Chatyy de email.'];
            }
            $emailDomain = strtolower(substr(strrchr($email, '@'), 1));
            $localDomains = ['chatyy.com.br', 'chatyy.com', 'onemundo.com.br'];
            if (!in_array($emailDomain, $localDomains, true)) {
                return ['error' => 'external_email', 'reason' => "Sua conta {$email} e externa ({$emailDomain}). Resumir emails so funciona com contas Chatyy. Crie um endereco @chatyy.com.br pra usar essa feature."];
            }
            $imap = @imap_open("{localhost:993/imap/ssl/novalidate-cert}$folder", $email, $password);
            if (!$imap) {
                $imapErr = imap_last_error() ?: 'unknown';
                return ['error' => 'imap_connect_failed', 'reason' => "Nao consegui acessar sua caixa de email: $imapErr"];
            }
            $uids = imap_search($imap, 'UNSEEN', SE_UID);
            $emails = [];
            if ($uids) {
                $uids = array_reverse($uids);
                $uids = array_slice($uids, 0, $limit);
                foreach ($uids as $uid) {
                    $msgno = imap_msgno($imap, $uid);
                    if (!$msgno) continue;
                    $header = imap_headerinfo($imap, $msgno);
                    $from = isset($header->from[0]) ? (($header->from[0]->personal ?? '') ?: ($header->from[0]->mailbox . '@' . $header->from[0]->host)) : '';
                    $subject = isset($header->subject) ? imap_utf8($header->subject) : '';
                    $date = isset($header->date) ? date('d/m H:i', strtotime($header->date)) : '';
                    $emails[] = "- De: $from | Assunto: $subject | Data: $date";
                }
            }
            try { imap_close($imap); } catch (\Throwable $e) {}
            return ['unread_count' => count($emails), 'emails' => implode("\n", $emails)];
        }

        case 'send_chat_message': {
            $recipientEmail = trim($toolInput['recipient_email'] ?? '');
            $msgText = trim($toolInput['message'] ?? '');
            if (!$recipientEmail || !$msgText) return ['error' => 'Recipient email and message are required'];
            if (!filter_var($recipientEmail, FILTER_VALIDATE_EMAIL)) return ['error' => 'Invalid recipient email'];

            $chatDb = new SQLite3('/var/www/mail/data/chat.db');
            $chatDb->busyTimeout(5000);
            $chatDb->exec('PRAGMA journal_mode=WAL');

            // Find existing direct conversation between the two users
            $stmt = $chatDb->prepare("
                SELECT c.id FROM conversations c
                JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.email = :sender
                JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.email = :recipient
                WHERE c.type = 'direct'
                LIMIT 1
            ");
            $stmt->bindValue(':sender', $email);
            $stmt->bindValue(':recipient', $recipientEmail);
            $result = $stmt->execute();
            $row = $result->fetchArray(SQLITE3_ASSOC);
            $conversationId2 = $row ? $row['id'] : null;

            // Create conversation if it doesn't exist
            if (!$conversationId2) {
                $stmt = $chatDb->prepare("INSERT INTO conversations (type, created_by, created_at, updated_at) VALUES ('direct', :creator, datetime('now'), datetime('now'))");
                $stmt->bindValue(':creator', $email);
                $stmt->execute();
                $conversationId2 = $chatDb->lastInsertRowID();

                // Add both members
                $stmt = $chatDb->prepare("INSERT INTO conversation_members (conversation_id, email, role, joined_at) VALUES (:cid, :email, 'member', datetime('now'))");
                $stmt->bindValue(':cid', $conversationId2);
                $stmt->bindValue(':email', $email);
                $stmt->execute();

                $stmt = $chatDb->prepare("INSERT INTO conversation_members (conversation_id, email, role, joined_at) VALUES (:cid, :email, 'member', datetime('now'))");
                $stmt->bindValue(':cid', $conversationId2);
                $stmt->bindValue(':email', $recipientEmail);
                $stmt->execute();
            }

            // Insert the message
            $stmt = $chatDb->prepare("INSERT INTO messages (conversation_id, sender_email, content, type, created_at) VALUES (:cid, :sender, :content, 'text', datetime('now'))");
            $stmt->bindValue(':cid', $conversationId2);
            $stmt->bindValue(':sender', $email);
            $stmt->bindValue(':content', $msgText);
            $stmt->execute();
            $messageId = $chatDb->lastInsertRowID();

            // Update conversation timestamp
            $chatUpd = $chatDb->prepare("UPDATE conversations SET updated_at=datetime('now') WHERE id=:cid");
            $chatUpd->bindValue(':cid', (int)$conversationId2, SQLITE3_INTEGER);
            $chatUpd->execute();

            $chatDb->close();

            return ['success' => true, 'message' => "Mensagem enviada para $recipientEmail", 'message_id' => $messageId, 'conversation_id' => $conversationId2];
        }


        case 'draft_email': {
            $to = $toolInput['to'] ?? '';
            $subject = $toolInput['subject'] ?? '';
            $body = $toolInput['body'] ?? '';
            if (!$to || !$subject) return ['error' => 'Recipient and subject required'];
            $imap = @imap_open("{localhost:993/imap/ssl/novalidate-cert}Drafts", $email, $password);
            if (!$imap) return ['error' => 'Could not connect'];
            $msg = "From: $email\r\nTo: $to\r\nSubject: $subject\r\nContent-Type: text/plain; charset=UTF-8\r\nDate: " . date('r') . "\r\n\r\n$body";
            $result = imap_append($imap, "{localhost:993/imap/ssl/novalidate-cert}Drafts", $msg, "\\Draft");
            try { imap_close($imap); } catch (\Throwable $e) {}
            return $result ? ['success' => true, 'message' => "Rascunho salvo! Para: $to, Assunto: $subject"] : ['error' => 'Failed to save draft'];
        }

        case 'list_contacts': {
            $search = strtolower(trim($toolInput['search'] ?? ''));
            $group = strtolower(trim($toolInput['group'] ?? ''));
            $parts = explode('@', $email);
            $contactsFile = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/contacts.json";
            if (!file_exists($contactsFile)) return ['contacts' => [], 'count' => 0];
            $contacts = json_decode(file_get_contents($contactsFile), true) ?: [];
            if ($search) {
                $contacts = array_filter($contacts, function($c) use ($search) {
                    return stripos($c['name'] ?? '', $search) !== false || stripos($c['email'] ?? '', $search) !== false || stripos($c['phone'] ?? '', $search) !== false;
                });
                $contacts = array_values($contacts);
            }
            if ($group) {
                $contacts = array_filter($contacts, function($c) use ($group) {
                    $cGroup = strtolower($c['group'] ?? $c['tag'] ?? $c['category'] ?? '');
                    $cGroups = is_array($c['groups'] ?? null) ? array_map('strtolower', $c['groups']) : [];
                    $cTags = is_array($c['tags'] ?? null) ? array_map('strtolower', $c['tags']) : [];
                    return stripos($cGroup, $group) !== false || in_array($group, $cGroups) || in_array($group, $cTags);
                });
                $contacts = array_values($contacts);
            }
            $contacts = array_slice($contacts, 0, 30);
            return ['contacts' => $contacts, 'count' => count($contacts)];
        }

        case 'create_meeting': {
            $title = $toolInput['title'] ?? '';
            if (!$title) return ['error' => 'Title required'];
            $participants = array_filter(array_map('trim', explode(',', $toolInput['participants'] ?? $email)));
            $scheduledAt = $toolInput['scheduled_at'] ?? date('Y-m-d\TH:i:s');
            $roomId = bin2hex(random_bytes(6));
            require_once __DIR__ . '/db.php';
            $meetDb = getPGDB();
            $stmt = $meetDb->prepare("INSERT INTO meet_meetings (room_id, title, creator_email, scheduled_at, status, created_at) VALUES (:room, :title, :host, :sched, 'active', NOW())");
            $stmt->execute([':room' => $roomId, ':title' => $title, ':host' => $email, ':sched' => $scheduledAt]);
            $meetId = $meetDb->lastInsertId();
            foreach ($participants as $p) {
                if (!filter_var($p, FILTER_VALIDATE_EMAIL)) continue;
                $stmt2 = $meetDb->prepare("INSERT INTO meet_meeting_participants (meeting_id, email, role) VALUES (:mid, :email, 'participant') ON CONFLICT DO NOTHING");
                $stmt2->execute([':mid' => $meetId, ':email' => $p]);
            }
            $link = "https://chatyy.com.br/meet/$roomId";
            return ['success' => true, 'meeting_id' => $meetId, 'room_id' => $roomId, 'link' => $link, 'message' => "Reuniao '$title' criada! Link: $link"];
        }

        case 'list_files': {
            $folderId = (int)($toolInput['folder_id'] ?? 0);
            $search = trim($toolInput['search'] ?? '');
            $fileType = trim($toolInput['file_type'] ?? 'all');
            $filesDb = new SQLite3('/var/www/mail/data/files.db');
            $filesDb->busyTimeout(3000);
            // List folders first, then files
            $items = [];

            // File type MIME filters
            $mimeFilter = '';
            switch ($fileType) {
                case 'photo': $mimeFilter = "AND mime_type LIKE 'image/%'"; break;
                case 'video': $mimeFilter = "AND mime_type LIKE 'video/%'"; break;
                case 'audio': $mimeFilter = "AND (mime_type LIKE 'audio/%')"; break;
                case 'document': $mimeFilter = "AND (mime_type LIKE 'application/pdf' OR mime_type LIKE 'application/msword%' OR mime_type LIKE 'application/vnd.openxmlformats%' OR mime_type LIKE 'text/%' OR mime_type LIKE 'application/vnd.ms-excel%' OR mime_type LIKE 'application/vnd.ms-powerpoint%')"; break;
                case 'archive': $mimeFilter = "AND (mime_type LIKE '%zip%' OR mime_type LIKE '%rar%' OR mime_type LIKE '%tar%' OR mime_type LIKE '%gzip%' OR mime_type LIKE '%7z%')"; break;
                default: $mimeFilter = ''; break;
            }

            // Folders (skip when filtering by type or searching)
            if ($fileType === 'all' && !$search) {
                $fStmt = $filesDb->prepare("SELECT id, name, 'folder' as type, created_at FROM folders WHERE owner_email=:email AND " . ($folderId ? "parent_id=:parent" : "parent_id IS NULL") . " ORDER BY name ASC");
                $fStmt->bindValue(':email', $email);
                if ($folderId) $fStmt->bindValue(':parent', $folderId);
                $fRes = $fStmt->execute();
                while ($row = $fRes->fetchArray(SQLITE3_ASSOC)) {
                    $items[] = $row;
                }
            }
            // Files
            if ($search) {
                $stmt = $filesDb->prepare("SELECT id, original_name as name, mime_type, size_bytes as size, created_at FROM files WHERE owner_email=:email AND is_trashed=0 AND original_name LIKE :search $mimeFilter ORDER BY created_at DESC LIMIT 30");
                $stmt->bindValue(':email', $email);
                $stmt->bindValue(':search', "%$search%");
            } else {
                $folderCond = ($fileType !== 'all') ? "1=1" : ($folderId ? "folder_id=:parent" : "folder_id IS NULL");
                $stmt = $filesDb->prepare("SELECT id, original_name as name, mime_type, size_bytes as size, created_at FROM files WHERE owner_email=:email AND $folderCond AND is_trashed=0 $mimeFilter ORDER BY created_at DESC LIMIT 30");
                $stmt->bindValue(':email', $email);
                if ($folderId && $fileType === 'all') $stmt->bindValue(':parent', $folderId);
            }
            $result = $stmt->execute();
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
                $row['type'] = 'file';
                $row['size_human'] = $row['size'] > 1048576 ? round($row['size']/1048576, 1).'MB' : round($row['size']/1024).'KB';
                $items[] = $row;
            }
            $filesDb->close();
            return ['files' => $items, 'count' => count($items), 'folder_id' => $folderId, 'file_type_filter' => $fileType];
        }

        case 'get_daily_briefing': {
            $briefing = [];
            // Unread emails
            $imap = @imap_open("{localhost:993/imap/ssl/novalidate-cert}INBOX", $email, $password);
            if ($imap) {
                $unread = imap_search($imap, 'UNSEEN', SE_UID);
                $unreadCount = $unread ? count($unread) : 0;
                $topEmails = [];
                if ($unread) {
                    $recent = array_slice(array_reverse($unread), 0, 5);
                    foreach ($recent as $uid) {
                        $msgno = imap_msgno($imap, $uid);
                        if (!$msgno) continue;
                        $h = imap_headerinfo($imap, $msgno);
                        $from = isset($h->from[0]) ? (($h->from[0]->personal ?? '') ?: ($h->from[0]->mailbox.'@'.$h->from[0]->host)) : '';
                        $subj = isset($h->subject) ? imap_utf8($h->subject) : '(sem assunto)';
                        $topEmails[] = "$from: $subj";
                    }
                }
                try { imap_close($imap); } catch (\Throwable $e) {}
                $briefing['unread_count'] = $unreadCount;
                $briefing['top_unread'] = $topEmails;
            }
            // Today's events
            $today = date('Y-m-d');
            $tomorrow = date('Y-m-d', strtotime('+1 day'));
            $calDb = new SQLite3('/var/www/mail/data/calendar.db');
            $calDb->busyTimeout(3000);
            $stmt = $calDb->prepare("SELECT title, start_at, end_at, location FROM events WHERE user_email=:email AND start_at >= :today AND start_at < :tomorrow ORDER BY start_at ASC LIMIT 10");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':today', $today . 'T00:00:00');
            $stmt->bindValue(':tomorrow', $tomorrow . 'T00:00:00');
            $result = $stmt->execute();
            $events = [];
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) { $events[] = $row; }
            $calDb->close();
            $briefing['today_events'] = $events;
            // Pending reminders
            $oneDb = oneGetDb();
            $stmt = $oneDb->prepare("SELECT action_data, trigger_at FROM one_scheduled WHERE user_email=:email AND status='pending' AND trigger_at >= :now ORDER BY trigger_at ASC LIMIT 5");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':now', date('Y-m-d\TH:i:s'));
            $result = $stmt->execute();
            $reminders = [];
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
                $data = json_decode($row['action_data'], true);
                $reminders[] = ['message' => $data['message'] ?? '', 'at' => $row['trigger_at']];
            }
            $oneDb->close();
            $briefing['pending_reminders'] = $reminders;
            return $briefing;
        }

        case 'forget_memory': {
            $key = $toolInput['key'] ?? '';
            if (!$key) return ['error' => 'Key required'];
            $db = oneGetDb();
            $stmt = $db->prepare("DELETE FROM one_memory WHERE user_email=:email AND key=:key");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':key', $key);
            $stmt->execute();
            $changes = $db->changes();
            $db->close();
            return $changes > 0 ? ['success' => true, 'message' => "Pronto, esqueci '$key'"] : ['error' => 'Memoria nao encontrada'];
        }
        case 'add_expense': {
            $amount = floatval($toolInput['amount'] ?? 0);
            $category = $toolInput['category'] ?? 'other';
            $description = trim($toolInput['description'] ?? '');
            $date = $toolInput['date'] ?? date('Y-m-d');
            $paymentMethod = trim($toolInput['payment_method'] ?? '');
            $recurring = !empty($toolInput['recurring']) ? 1 : 0;
            if ($amount <= 0) return ['error' => 'Amount must be positive'];
            if (!$description) return ['error' => 'Description required'];
            $validCategories = ['food', 'transport', 'health', 'entertainment', 'bills', 'shopping', 'education', 'pets', 'home', 'travel', 'subscriptions', 'other'];
            if (!in_array($category, $validCategories)) $category = 'other';
            $db = oneGetDb();
            $stmt = $db->prepare("INSERT INTO one_expenses (user_email, amount, category, description, date, payment_method, recurring) VALUES (:email, :amount, :cat, :desc, :date, :pay, :rec)");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':amount', $amount);
            $stmt->bindValue(':cat', $category);
            $stmt->bindValue(':desc', $description);
            $stmt->bindValue(':date', $date);
            $stmt->bindValue(':pay', $paymentMethod);
            $stmt->bindValue(':rec', $recurring, SQLITE3_INTEGER);
            $stmt->execute();
            $id = $db->lastInsertRowID();
            $db->close();
            return ['saved' => true, 'id' => $id, 'amount' => $amount, 'category' => $category, 'description' => $description];
        }

        case 'list_expenses': {
            $startDate = $toolInput['start_date'] ?? date('Y-m-01');
            $endDate = $toolInput['end_date'] ?? date('Y-m-d');
            $category = $toolInput['category'] ?? null;
            $db = oneGetDb();
            if ($category) {
                $stmt = $db->prepare("SELECT id, amount, category, description, date, payment_method, recurring FROM one_expenses WHERE user_email=:email AND date >= :start AND date <= :end AND category=:cat ORDER BY date DESC");
                $stmt->bindValue(':cat', $category);
            } else {
                $stmt = $db->prepare("SELECT id, amount, category, description, date, payment_method, recurring FROM one_expenses WHERE user_email=:email AND date >= :start AND date <= :end ORDER BY date DESC");
            }
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':start', $startDate);
            $stmt->bindValue(':end', $endDate);
            $result = $stmt->execute();
            $expenses = [];
            $total = 0;
            $byCategory = [];
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
                $expenses[] = $row;
                $total += $row['amount'];
                $cat = $row['category'];
                $byCategory[$cat] = ($byCategory[$cat] ?? 0) + $row['amount'];
            }
            $db->close();
            arsort($byCategory);
            return [
                'expenses' => $expenses,
                'total' => round($total, 2),
                'count' => count($expenses),
                'by_category' => $byCategory,
                'period' => "$startDate a $endDate",
            ];
        }

        case 'expense_report': {
            $month = $toolInput['month'] ?? date('Y-m');
            $startDate = $month . '-01';
            $endDate = date('Y-m-t', strtotime($startDate));
            // Previous month for comparison
            $prevStart = date('Y-m-01', strtotime($startDate . ' -1 month'));
            $prevEnd = date('Y-m-t', strtotime($prevStart));

            $db = oneGetDb();

            // Current month
            $stmt = $db->prepare("SELECT amount, category, description, date, payment_method, recurring FROM one_expenses WHERE user_email=:email AND date >= :start AND date <= :end ORDER BY date DESC");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':start', $startDate);
            $stmt->bindValue(':end', $endDate);
            $result = $stmt->execute();
            $current = [];
            $currentTotal = 0;
            $currentByCategory = [];
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
                $current[] = $row;
                $currentTotal += $row['amount'];
                $cat = $row['category'];
                $currentByCategory[$cat] = ($currentByCategory[$cat] ?? 0) + $row['amount'];
            }

            // Previous month
            $stmt2 = $db->prepare("SELECT amount, category FROM one_expenses WHERE user_email=:email AND date >= :start AND date <= :end");
            $stmt2->bindValue(':email', $email);
            $stmt2->bindValue(':start', $prevStart);
            $stmt2->bindValue(':end', $prevEnd);
            $result2 = $stmt2->execute();
            $prevTotal = 0;
            $prevByCategory = [];
            while ($row = $result2->fetchArray(SQLITE3_ASSOC)) {
                $prevTotal += $row['amount'];
                $cat = $row['category'];
                $prevByCategory[$cat] = ($prevByCategory[$cat] ?? 0) + $row['amount'];
            }

            // Recurring expenses
            $stmt3 = $db->prepare("SELECT SUM(amount) as total FROM one_expenses WHERE user_email=:email AND recurring=1 AND date >= :start AND date <= :end");
            $stmt3->bindValue(':email', $email);
            $stmt3->bindValue(':start', $startDate);
            $stmt3->bindValue(':end', $endDate);
            $r3 = $stmt3->execute();
            $recurringTotal = 0;
            if ($row3 = $r3->fetchArray(SQLITE3_ASSOC)) {
                $recurringTotal = $row3['total'] ?? 0;
            }

            // Top 5 biggest expenses
            $stmt4 = $db->prepare("SELECT amount, description, date, category FROM one_expenses WHERE user_email=:email AND date >= :start AND date <= :end ORDER BY amount DESC LIMIT 5");
            $stmt4->bindValue(':email', $email);
            $stmt4->bindValue(':start', $startDate);
            $stmt4->bindValue(':end', $endDate);
            $result4 = $stmt4->execute();
            $topExpenses = [];
            while ($row = $result4->fetchArray(SQLITE3_ASSOC)) {
                $topExpenses[] = $row;
            }

            $db->close();

            arsort($currentByCategory);
            $variation = $prevTotal > 0 ? round((($currentTotal - $prevTotal) / $prevTotal) * 100, 1) : null;

            // Category comparison
            $categoryComparison = [];
            $allCats = array_unique(array_merge(array_keys($currentByCategory), array_keys($prevByCategory)));
            foreach ($allCats as $cat) {
                $cur = $currentByCategory[$cat] ?? 0;
                $prev = $prevByCategory[$cat] ?? 0;
                $catVar = $prev > 0 ? round((($cur - $prev) / $prev) * 100, 1) : null;
                $categoryComparison[$cat] = [
                    'current' => round($cur, 2),
                    'previous' => round($prev, 2),
                    'variation_pct' => $catVar,
                ];
            }

            return [
                'month' => $month,
                'total' => round($currentTotal, 2),
                'count' => count($current),
                'recurring_total' => round($recurringTotal, 2),
                'by_category' => $currentByCategory,
                'top_expenses' => $topExpenses,
                'previous_month' => [
                    'total' => round($prevTotal, 2),
                    'variation_pct' => $variation,
                ],
                'category_comparison' => $categoryComparison,
                'daily_average' => count($current) > 0 ? round($currentTotal / (int)date('j', strtotime($endDate)), 2) : 0,
            ];
        }

        case 'send_sms': {
            $to = $toolInput['to'] ?? '';
            $message = $toolInput['message'] ?? '';
            if (!$to || !$message) return ['error' => 'Phone number and message required'];

            // Normalize phone
            $to = preg_replace('/[^+0-9]/', '', $to);
            if (!str_starts_with($to, '+')) $to = '+55' . $to;

            // Try SMS first
            $smsResult = oneSendSms($to, $message);
            if (!empty($smsResult['success'])) {
                $smsResult['phone'] = $to;
                return $smsResult;
            }

            // SMS failed (likely A2P block for US numbers) → fallback to voice call
            if (str_starts_with($to, '+1')) {
                $callResult = oneMakeCall($to, $message);
                if (!empty($callResult['success'])) {
                    $callResult['note'] = 'SMS falhou para numero US (A2P), fiz ligacao de voz no lugar';
                    $callResult['phone'] = $to;
                    return $callResult;
                }
            }

            $smsResult['phone'] = $to;
            return $smsResult;
        }

        case 'create_document': {
            $title = trim($toolInput['title'] ?? '');
            $content = $toolInput['content'] ?? '';
            if (!$title) return ['error' => 'Title is required'];

            $folderId = isset($toolInput['folder_id']) ? (int)$toolInput['folder_id'] : null;
            $docId = 'doc-' . bin2hex(random_bytes(8));

            // Convert HTML/text content to CKEditor-compatible JSON format
            $docContent = json_encode([
                'type' => 'doc',
                'content' => [
                    ['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => '']]],
                ],
                'html' => $content,
            ]);

            $docsDb = oneGetDocsDb();

            if ($folderId) {
                $fCheck = $docsDb->prepare('SELECT id FROM docs_doc_folders WHERE id = :id AND owner_email = :email');
                $fCheck->execute([':id' => $folderId, ':email' => $email]);
                if (!$fCheck->fetch()) $folderId = null;
            }

            $stmt = $docsDb->prepare("
                INSERT INTO docs_documents (doc_id, title, type, owner_email, owner_name, content, folder_id, file_size)
                VALUES (:doc_id, :title, 'document', :email, :name, :content, :folder, :file_size)
            ");
            $stmt->execute([
                ':doc_id' => $docId,
                ':title' => $title,
                ':email' => $email,
                ':name' => $email,
                ':content' => $docContent,
                ':folder' => $folderId,
                ':file_size' => strlen($docContent),
            ]);
            $numericId = $docsDb->lastInsertId();
            $url = "https://chatyy.com.br/docs/editor.html?id={$docId}";

            return ['success' => true, 'id' => (int)$numericId, 'doc_id' => $docId, 'title' => $title, 'url' => $url, 'message' => "Documento '$title' criado! Abra aqui: $url"];
        }

        case 'create_spreadsheet': {
            $title = trim($toolInput['title'] ?? '');
            $headers = $toolInput['headers'] ?? [];
            $data = $toolInput['data'] ?? [];
            if (!$title) return ['error' => 'Title is required'];
            if (empty($headers) || !is_array($headers)) return ['error' => 'Headers array is required'];

            $folderId = isset($toolInput['folder_id']) ? (int)$toolInput['folder_id'] : null;
            $docId = 'doc-' . bin2hex(random_bytes(8));

            // Build jspreadsheet-compatible content
            $numCols = count($headers);
            $numRows = max(100, count($data) + 1);

            // Build data grid: first row is headers conceptually, but jspreadsheet uses column titles
            $gridData = [];
            // Fill with provided data rows
            foreach ($data as $row) {
                $paddedRow = array_pad(is_array($row) ? $row : [], $numCols, '');
                $gridData[] = array_slice($paddedRow, 0, $numCols);
            }
            // Fill remaining rows with empty data
            $remainingRows = $numRows - count($gridData);
            for ($i = 0; $i < $remainingRows; $i++) {
                $gridData[] = array_fill(0, $numCols, '');
            }

            $sheetContent = json_encode([
                'sheets' => [[
                    'name' => 'Planilha 1',
                    'data' => $gridData,
                    'colWidths' => array_fill(0, $numCols, 120),
                    'rowHeights' => array_fill(0, $numRows, 25),
                    'styles' => [],
                    'merges' => [],
                    'headers' => $headers,
                ]],
                'activeSheet' => 0,
            ]);

            $docsDb = oneGetDocsDb();

            if ($folderId) {
                $fCheck = $docsDb->prepare('SELECT id FROM docs_doc_folders WHERE id = :id AND owner_email = :email');
                $fCheck->execute([':id' => $folderId, ':email' => $email]);
                if (!$fCheck->fetch()) $folderId = null;
            }

            $stmt = $docsDb->prepare("
                INSERT INTO docs_documents (doc_id, title, type, owner_email, owner_name, content, folder_id, file_size)
                VALUES (:doc_id, :title, 'spreadsheet', :email, :name, :content, :folder, :file_size)
            ");
            $stmt->execute([
                ':doc_id' => $docId,
                ':title' => $title,
                ':email' => $email,
                ':name' => $email,
                ':content' => $sheetContent,
                ':folder' => $folderId,
                ':file_size' => strlen($sheetContent),
            ]);
            $numericId = $docsDb->lastInsertId();
            $url = "https://chatyy.com.br/docs/spreadsheet.html?id={$docId}";

            return ['success' => true, 'id' => (int)$numericId, 'doc_id' => $docId, 'title' => $title, 'url' => $url, 'message' => "Planilha '$title' criada! Abra aqui: $url"];
        }

        case 'edit_document': {
            $docNumericId = (int)($toolInput['doc_id'] ?? 0);
            $content = $toolInput['content'] ?? '';
            if (!$docNumericId) return ['error' => 'doc_id is required'];

            $docsDb = oneGetDocsDb();

            // Find document and verify ownership
            $stmt = $docsDb->prepare("SELECT id, doc_id, type, owner_email, version FROM docs_documents WHERE id = :id");
            $stmt->execute([':id' => $docNumericId]);
            $doc = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$doc) return ['error' => 'Document not found'];
            if (strtolower($doc['owner_email']) !== strtolower($email)) {
                // Check if user has edit permission via shares
                $sCheck = $docsDb->prepare("SELECT permission FROM docs_doc_shares WHERE document_id = :did AND shared_with = :email AND permission IN ('edit','admin')");
                $sCheck->execute([':did' => $doc['id'], ':email' => strtolower($email)]);
                if (!$sCheck->fetch()) return ['error' => 'No edit permission for this document'];
            }

            // Wrap content appropriately based on type
            if ($doc['type'] === 'document') {
                $docContent = json_encode([
                    'type' => 'doc',
                    'content' => [
                        ['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => '']]],
                    ],
                    'html' => $content,
                ]);
            } else {
                $docContent = $content;
            }

            $newVersion = $doc['version'] + 1;
            $stmt = $docsDb->prepare("UPDATE docs_documents SET content = :content, version = :version, updated_at = iso_now(), last_edited_by = :email WHERE id = :id");
            $stmt->execute([
                ':content' => $docContent,
                ':version' => $newVersion,
                ':email' => $email,
                ':id' => $docNumericId,
            ]);

            return ['success' => true, 'doc_id' => $doc['doc_id'], 'version' => $newVersion, 'message' => 'Documento atualizado!'];
        }

        case 'list_documents': {
            $folderId = isset($toolInput['folder_id']) ? (int)$toolInput['folder_id'] : null;
            $limit = min((int)($toolInput['limit'] ?? 20), 50);

            $docsDb = oneGetDocsDb();

            $conditions = ['(d.owner_email = :email OR s.shared_with = :email2)', 'd.is_trashed = 0'];
            $params = [':email' => $email, ':email2' => $email];

            if ($folderId !== null) {
                $conditions[] = 'd.folder_id = :folder';
                $params[':folder'] = $folderId;
            }

            $where = implode(' AND ', $conditions);
            $sql = "
                SELECT d.id, d.doc_id, d.title, d.type, d.owner_email, d.is_starred, d.folder_id, d.updated_at, d.created_at,
                    CASE WHEN d.owner_email = :email3 THEN 'owner' ELSE COALESCE(s.permission, 'view') END AS my_permission
                FROM docs_documents d
                LEFT JOIN docs_doc_shares s ON s.document_id = d.id AND s.shared_with = :email4
                WHERE {$where}
                ORDER BY d.updated_at DESC
                LIMIT :limit
            ";
            $params[':email3'] = $email;
            $params[':email4'] = $email;
            $params[':limit'] = $limit;

            $stmt = $docsDb->prepare($sql);
            $stmt->execute($params);
            $docs = $stmt->fetchAll(PDO::FETCH_ASSOC);

            $result = [];
            foreach ($docs as $d) {
                $editorPage = $d['type'] === 'spreadsheet' ? 'spreadsheet.html' : 'editor.html';
                $result[] = [
                    'id' => (int)$d['id'],
                    'doc_id' => $d['doc_id'],
                    'title' => $d['title'],
                    'type' => $d['type'],
                    'owner' => $d['owner_email'],
                    'starred' => (bool)$d['is_starred'],
                    'updated_at' => $d['updated_at'],
                    'url' => "https://chatyy.com.br/docs/{$editorPage}?id={$d['doc_id']}",
                    'permission' => $d['my_permission'],
                ];
            }

            return ['documents' => $result, 'count' => count($result)];
        }

        case 'search_users': {
            $query = strtolower(trim($toolInput['query'] ?? ''));
            if (!$query) return ['users' => [], 'count' => 0];
            $results = [];
            $domains = glob('/var/mail/vhosts/*', GLOB_ONLYDIR) ?: [];
            foreach ($domains as $domainDir) {
                $domain = basename($domainDir);
                if (!str_contains($domain, '.')) continue;
                $users = glob("{$domainDir}/*", GLOB_ONLYDIR) ?: [];
                foreach ($users as $userDir) {
                    $username = basename($userDir);
                    if (!is_dir("{$userDir}/Maildir")) continue;
                    $accountEmail = strtolower("{$username}@{$domain}");
                    if ($accountEmail === strtolower($email)) continue;

                    // Load profile from profile/data.json
                    $pd = null;
                    $profileFile = "{$userDir}/profile/data.json";
                    if (file_exists($profileFile)) {
                        $pd = @json_decode(@file_get_contents($profileFile), true);
                    }
                    $name = ($pd['first_name'] ?? '') . ' ' . ($pd['last_name'] ?? '');
                    $name = trim($name) ?: ($pd['name'] ?? $username);
                    $phone = $pd['verified_phone'] ?? ($pd['phone'] ?? '');

                    // Match query against email, name, username, and phone
                    $match = str_contains($accountEmail, $query)
                        || str_contains(strtolower($name), $query)
                        || str_contains(strtolower($username), $query)
                        || ($phone && str_contains(preg_replace('/\D/', '', $phone), preg_replace('/\D/', '', $query)));

                    if ($match) {
                        $results[] = [
                            'email' => $accountEmail,
                            'name'  => $name,
                            'phone' => $phone,
                        ];
                    }
                    if (count($results) >= 20) break 2;
                }
            }
            return ['users' => $results, 'count' => count($results)];
        }

        case 'send_whatsapp': {
            $to = $toolInput['to'] ?? '';
            $msg = $toolInput['message'] ?? '';
            if (!$to || !$msg) return ['error' => 'Phone number and message required'];

            // Normalize phone
            $normalizedTo = preg_replace('/[^+0-9]/', '', $to);
            if (!str_starts_with($normalizedTo, '+')) $normalizedTo = '+55' . $normalizedTo;

            // 1. Always try UTILITY template first (works for ANY number worldwide, no opt-in)
            $utilityTplSid = '';
            if (file_exists('/etc/mail-api.env')) {
                foreach (file('/etc/mail-api.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $envLine) {
                    if (strpos($envLine, '#') === 0) continue;
                    if (strpos($envLine, 'WA_TPL_REMINDER_UTILITY=') === 0) $utilityTplSid = trim(substr($envLine, strlen('WA_TPL_REMINDER_UTILITY=')));
                }
            }
            if ($utilityTplSid) {
                // UTILITY template variable {{1}} has a 1024 char limit
                // If message is longer, split into multiple sends
                $tplCharLimit = 1024;
                if (mb_strlen($msg) > $tplCharLimit) {
                    // Split message into chunks and send each as a separate template message
                    $chunks = [];
                    $remaining = $msg;
                    $partNum = 0;
                    while (mb_strlen($remaining) > 0) {
                        $partNum++;
                        if (mb_strlen($remaining) <= $tplCharLimit) {
                            $chunks[] = $remaining;
                            break;
                        }
                        // Find a good break point (newline or space) near the limit
                        $breakAt = $tplCharLimit;
                        $lastNewline = mb_strrpos(mb_substr($remaining, 0, $tplCharLimit), "\n");
                        $lastSpace = mb_strrpos(mb_substr($remaining, 0, $tplCharLimit), ' ');
                        if ($lastNewline !== false && $lastNewline > $tplCharLimit * 0.5) {
                            $breakAt = $lastNewline;
                        } elseif ($lastSpace !== false && $lastSpace > $tplCharLimit * 0.5) {
                            $breakAt = $lastSpace;
                        }
                        $chunks[] = mb_substr($remaining, 0, $breakAt);
                        $remaining = mb_substr($remaining, $breakAt);
                    }

                    $allSuccess = true;
                    $lastResult = null;
                    foreach ($chunks as $i => $chunk) {
                        $chunkMsg = count($chunks) > 1
                            ? "(" . ($i + 1) . "/" . count($chunks) . ") " . $chunk
                            : $chunk;
                        $lastResult = oneSendWhatsapp($normalizedTo, $chunkMsg, $utilityTplSid, ['1' => $chunkMsg]);
                        if (empty($lastResult['success'])) {
                            $allSuccess = false;
                            break;
                        }
                        // Small delay between sends to avoid rate limiting
                        if ($i < count($chunks) - 1) usleep(500000);
                    }
                    if ($allSuccess && $lastResult) {
                        $lastResult['method'] = 'utility_template';
                        $lastResult['parts_sent'] = count($chunks);
                        return $lastResult;
                    }
                    // If chunked template failed, fall through to freeform
                } else {
                    $tplResult = oneSendWhatsapp($normalizedTo, $msg, $utilityTplSid, ['1' => $msg]);
                    if (!empty($tplResult['success'])) {
                        $tplResult['method'] = 'utility_template';
                        return $tplResult;
                    }
                }
            }

            // 2. Try freeform (works within 24h window)
            $freeResult = oneSendWhatsapp($normalizedTo, $msg);
            if (!empty($freeResult['success'])) return $freeResult;

            // 3. For US numbers, try Z-API as fallback
            if (str_starts_with($normalizedTo, '+1')) {
                $zapiResult = oneSendZapiWhatsapp($normalizedTo, $msg);
                if (!empty($zapiResult['success'])) return $zapiResult;
            }

            // Return the error from the best attempt
            return $freeResult;
        }

        case 'make_call': {
            $to = $toolInput['to'] ?? '';
            $msg = $toolInput['message'] ?? '';
            if (!$to || !$msg) return ['error' => 'Phone number and message required'];
            return oneMakeCall($to, $msg);
        }

        case 'schedule_message': {
            $type = $toolInput['type'] ?? '';
            $to = trim($toolInput['to'] ?? '');
            $content = $toolInput['content'] ?? '';
            $sendAt = $toolInput['send_at'] ?? '';
            if (!$type || !$to || !$content || !$sendAt) {
                return ['error' => 'Type, to, content, and send_at are all required'];
            }
            $validTypes = ['whatsapp', 'sms', 'email', 'chat', 'call'];
            if (!in_array($type, $validTypes, true)) {
                return ['error' => 'Invalid type. Must be: ' . implode(', ', $validTypes)];
            }
            // Validate send_at is in the future
            $sendTs = strtotime($sendAt);
            if (!$sendTs || $sendTs <= time()) {
                return ['error' => 'send_at must be a valid future datetime'];
            }

            $actionType = 'scheduled_' . $type; // scheduled_whatsapp, scheduled_sms, etc.
            $db = oneGetDb();
            $stmt = $db->prepare("INSERT INTO one_scheduled (user_email, action_type, action_data, trigger_at) VALUES (:email, :type, :data, :trigger)");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':type', $actionType);
            $stmt->bindValue(':data', json_encode([
                'to' => $to,
                'content' => $content,
                'message_type' => $type,
            ]));
            $stmt->bindValue(':trigger', date('Y-m-d\TH:i:s', $sendTs));
            $stmt->execute();
            $schedId = $db->lastInsertRowID();
            $db->close();

            $typeLabels = [
                'whatsapp' => 'WhatsApp',
                'sms' => 'SMS',
                'email' => 'email',
                'chat' => 'mensagem no chat',
                'call' => 'ligacao',
            ];
            $label = $typeLabels[$type] ?? $type;
            return [
                'success' => true,
                'id' => $schedId,
                'message' => "Agendado! Vou enviar o $label para $to em " . date('d/m/Y H:i', $sendTs),
            ];
        }

        case 'create_note': {
            $title = trim($toolInput['title'] ?? '');
            $content = trim($toolInput['content'] ?? '');
            $color = $toolInput['color'] ?? '#FFF9C4';
            if (!$title && !$content) return ['error' => 'Title or content required'];

            require_once __DIR__ . '/db.php';
            $ndb = getPGDB();
            $ndb->exec("CREATE TABLE IF NOT EXISTS chatyy_notes (id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', color TEXT DEFAULT '#FFF9C4', notebook_id INTEGER, is_pinned INTEGER DEFAULT 0, is_sticky INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0, tags TEXT DEFAULT '[]', position_x REAL DEFAULT 0, position_y REAL DEFAULT 0, width REAL DEFAULT 200, height REAL DEFAULT 200, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())");
            $stmt = $ndb->prepare("INSERT INTO chatyy_notes (user_email, title, content, color) VALUES (?, ?, ?, ?) RETURNING id");
            $stmt->execute([$email, $title, $content, strtoupper($color)]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            return ['success' => true, 'note_id' => (int)$row['id'], 'message' => "Nota criada: \"$title\""];
        }

        case 'list_notes': {
            $search = $toolInput['search'] ?? '';
            $limit = min((int)($toolInput['limit'] ?? 20), 50);

            require_once __DIR__ . '/db.php';
            $ndb = getPGDB();
            $ndb->exec("CREATE TABLE IF NOT EXISTS chatyy_notes (id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', color TEXT DEFAULT '#FFF9C4', notebook_id INTEGER, is_pinned INTEGER DEFAULT 0, is_sticky INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0, tags TEXT DEFAULT '[]', position_x REAL DEFAULT 0, position_y REAL DEFAULT 0, width REAL DEFAULT 200, height REAL DEFAULT 200, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())");

            if ($search) {
                $stmt = $ndb->prepare("SELECT id, title, SUBSTRING(content, 1, 200) AS content_preview, color, is_pinned, is_sticky, created_at FROM chatyy_notes WHERE user_email = ? AND is_archived = 0 AND (LOWER(title) LIKE ? OR LOWER(content) LIKE ?) ORDER BY is_pinned DESC, updated_at DESC LIMIT ?");
                $like = '%' . mb_strtolower($search) . '%';
                $stmt->execute([$email, $like, $like, $limit]);
            } else {
                $stmt = $ndb->prepare("SELECT id, title, SUBSTRING(content, 1, 200) AS content_preview, color, is_pinned, is_sticky, created_at FROM chatyy_notes WHERE user_email = ? AND is_archived = 0 ORDER BY is_pinned DESC, updated_at DESC LIMIT ?");
                $stmt->execute([$email, $limit]);
            }
            $notes = $stmt->fetchAll(PDO::FETCH_ASSOC);
            $count = count($notes);

            $summary = $count === 0 ? 'Nenhuma nota encontrada.' : "Encontradas $count notas:";
            foreach ($notes as $n) {
                $summary .= "\n- [{$n['id']}] " . ($n['title'] ?: '(sem titulo)') . ($n['is_pinned'] ? ' (fixada)' : '');
            }
            return ['notes' => $notes, 'count' => $count, 'message' => $summary];
        }

        case 'create_sticky': {
            $title = trim($toolInput['title'] ?? '');
            $content = trim($toolInput['content'] ?? '');
            $color = $toolInput['color'] ?? '#FFF9C4';
            if (!$title) return ['error' => 'Title required for sticky note'];

            require_once __DIR__ . '/db.php';
            $ndb = getPGDB();
            $ndb->exec("CREATE TABLE IF NOT EXISTS chatyy_notes (id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', color TEXT DEFAULT '#FFF9C4', notebook_id INTEGER, is_pinned INTEGER DEFAULT 0, is_sticky INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0, tags TEXT DEFAULT '[]', position_x REAL DEFAULT 0, position_y REAL DEFAULT 0, width REAL DEFAULT 200, height REAL DEFAULT 200, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())");
            $stmt = $ndb->prepare("INSERT INTO chatyy_notes (user_email, title, content, color, is_pinned, is_sticky) VALUES (?, ?, ?, ?, 1, 1) RETURNING id");
            $stmt->execute([$email, $title, $content, strtoupper($color)]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            return ['success' => true, 'note_id' => (int)$row['id'], 'message' => "Sticky note criada e fixada: \"$title\""];
        }

        case 'check_storage': {
            $filesDb = new SQLite3('/var/www/mail/data/files.db');
            $filesDb->busyTimeout(3000);

            // Total files size
            $stmt = $filesDb->prepare("SELECT COUNT(*) as file_count, COALESCE(SUM(size_bytes), 0) as total_bytes FROM files WHERE owner_email=:email AND is_trashed=0");
            $stmt->bindValue(':email', $email);
            $row = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
            $fileCount = (int)$row['file_count'];
            $totalBytes = (int)$row['total_bytes'];

            // Trashed files
            $stmt2 = $filesDb->prepare("SELECT COUNT(*) as trash_count, COALESCE(SUM(size_bytes), 0) as trash_bytes FROM files WHERE owner_email=:email AND is_trashed=1");
            $stmt2->bindValue(':email', $email);
            $trash = $stmt2->execute()->fetchArray(SQLITE3_ASSOC);
            $trashCount = (int)$trash['trash_count'];
            $trashBytes = (int)$trash['trash_bytes'];

            // Folder count
            $stmt3 = $filesDb->prepare("SELECT COUNT(*) as folder_count FROM folders WHERE owner_email=:email");
            $stmt3->bindValue(':email', $email);
            $folders = $stmt3->execute()->fetchArray(SQLITE3_ASSOC);
            $folderCount = (int)$folders['folder_count'];

            $filesDb->close();

            // Documents count
            $docsDb = oneGetDocsDb();
            $dStmt = $docsDb->prepare("SELECT COUNT(*) as doc_count FROM docs_documents WHERE owner_email = :email AND is_trashed = 0");
            $dStmt->execute([':email' => $email]);
            $docCount = (int)$dStmt->fetchColumn();

            // Format sizes
            $formatSize = function($bytes) {
                if ($bytes >= 1073741824) return round($bytes / 1073741824, 2) . ' GB';
                if ($bytes >= 1048576) return round($bytes / 1048576, 1) . ' MB';
                if ($bytes >= 1024) return round($bytes / 1024) . ' KB';
                return $bytes . ' bytes';
            };

            return [
                'files' => $fileCount,
                'folders' => $folderCount,
                'documents' => $docCount,
                'total_size' => $formatSize($totalBytes),
                'total_bytes' => $totalBytes,
                'trash_files' => $trashCount,
                'trash_size' => $formatSize($trashBytes),
                'message' => "Voce tem $fileCount arquivos ({$formatSize($totalBytes)}), $folderCount pastas e $docCount documentos." .
                    ($trashCount > 0 ? " Na lixeira: $trashCount arquivos ({$formatSize($trashBytes)})." : ''),
            ];
        }

        case 'get_plan_info': {
            require_once __DIR__ . '/chat.php';
            require_once __DIR__ . '/plans.php';
            $db2 = getChatDB();
            initPlansDB($db2);
            $plan = getUserPlan($email);
            if (!$plan) {
                $plan = ['plan' => 'free', 'storage_limit' => 20*1024*1024*1024];
            }

            // Get current storage usage
            $filesDb = new SQLite3('/var/www/mail/data/files.db');
            $filesDb->busyTimeout(3000);
            $stmt = $filesDb->prepare("SELECT COALESCE(SUM(size_bytes), 0) as total_bytes FROM files WHERE owner_email=:email AND is_trashed=0");
            $stmt->bindValue(':email', $email);
            $row = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
            $usedBytes = (int)$row['total_bytes'];
            $filesDb->close();

            $formatSize = function($bytes) {
                if ($bytes >= 1073741824) return round($bytes / 1073741824, 2) . ' GB';
                if ($bytes >= 1048576) return round($bytes / 1048576, 1) . ' MB';
                if ($bytes >= 1024) return round($bytes / 1024) . ' KB';
                return $bytes . ' bytes';
            };

            $limitBytes = (int)($plan['storage_limit'] ?? 20*1024*1024*1024);
            $planNames = ['free' => 'Grátis', 'one' => 'Chatyy One', 'family' => 'Chatyy Família'];

            return [
                'plan' => $plan['plan'],
                'plan_display_name' => $planNames[$plan['plan']] ?? $plan['plan'],
                'storage_used' => $formatSize($usedBytes),
                'storage_used_bytes' => $usedBytes,
                'storage_limit' => $formatSize($limitBytes),
                'storage_limit_bytes' => $limitBytes,
                'storage_percent' => $limitBytes > 0 ? round($usedBytes / $limitBytes * 100, 1) : 0,
                'billing_period' => $plan['billing_period'] ?? null,
                'started_at' => $plan['started_at'] ?? null,
                'expires_at' => $plan['expires_at'] ?? null,
                'family_admin' => $plan['family_admin'] ?? null,
                'price' => $plan['price'] ?? 0,
            ];
        }

        case 'subscribe_plan': {
            $targetPlan = $toolInput['plan'] ?? 'one';
            if (!in_array($targetPlan, ['one', 'family'], true)) {
                return ['error' => 'Invalid plan. Choose "one" or "family".'];
            }
            $planNames = ['one' => 'Chatyy One', 'family' => 'Chatyy Família'];
            $planPrices = ['one' => 'R$12,99/mês', 'family' => 'R$19,99/mês'];
            return [
                'success' => true,
                'plan' => $targetPlan,
                'plan_name' => $planNames[$targetPlan],
                'price' => $planPrices[$targetPlan],
                'link' => '/plans?plan=' . $targetPlan,
                'message' => "Link para assinar o {$planNames[$targetPlan]}: [Assinar {$planNames[$targetPlan]} →](/plans?plan={$targetPlan})",
            ];
        }

        case 'cancel_plan': {
            require_once __DIR__ . '/chat.php';
            require_once __DIR__ . '/plans.php';
            $db2 = getChatDB();
            initPlansDB($db2);
            $currentPlan = getUserPlan($email);
            if (!$currentPlan || $currentPlan['plan'] === 'free') {
                return ['error' => 'Você já está no plano Grátis. Não há assinatura para cancelar.'];
            }

            // Cancel: revert to free
            if (!setPlan($email, 'free')) {
                return ['error' => 'Falha ao cancelar o plano. Tente novamente.'];
            }

            $planNames = ['one' => 'Chatyy One', 'family' => 'Chatyy Família'];
            $oldPlan = $planNames[$currentPlan['plan']] ?? $currentPlan['plan'];
            return [
                'success' => true,
                'message' => "Assinatura do {$oldPlan} cancelada. Você agora está no plano Grátis.",
                'old_plan' => $currentPlan['plan'],
                'new_plan' => 'free',
            ];
        }

        case 'read_document': {
            $docId = (int)($toolInput['document_id'] ?? 0);
            if (!$docId) return ['error' => 'document_id is required'];

            $docsDb = oneGetDocsDb();

            $stmt = $docsDb->prepare("SELECT id, doc_id, title, type, owner_email, content, created_at, updated_at FROM docs_documents WHERE id = :id AND is_trashed = 0");
            $stmt->execute([':id' => $docId]);
            $doc = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$doc) return ['error' => 'Document not found'];

            // Check ownership or share access
            if (strtolower($doc['owner_email']) !== strtolower($email)) {
                $sCheck = $docsDb->prepare("SELECT permission FROM docs_doc_shares WHERE document_id = :did AND shared_with = :email");
                $sCheck->execute([':did' => $doc['id'], ':email' => strtolower($email)]);
                if (!$sCheck->fetch()) return ['error' => 'No permission to read this document'];
            }

            // Extract readable text from content
            $content = $doc['content'];
            $textContent = '';
            $decoded = json_decode($content, true);
            if ($decoded && isset($decoded['html'])) {
                $textContent = strip_tags($decoded['html']);
            } elseif ($decoded && isset($decoded['content'])) {
                // Try extracting text from structured content
                $textContent = strip_tags($content);
            } else {
                $textContent = strip_tags($content);
            }
            $textContent = html_entity_decode($textContent, ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $textContent = preg_replace('/\s+/', ' ', trim($textContent));
            // Truncate to avoid excessive token usage
            $textContent = mb_substr($textContent, 0, 8000);

            return [
                'id' => (int)$doc['id'],
                'doc_id' => $doc['doc_id'],
                'title' => $doc['title'],
                'type' => $doc['type'],
                'content' => $textContent,
                'owner' => $doc['owner_email'],
                'created_at' => $doc['created_at'],
                'updated_at' => $doc['updated_at'],
            ];
        }

        case 'read_spreadsheet': {
            $docId = (int)($toolInput['document_id'] ?? 0);
            if (!$docId) return ['error' => 'document_id is required'];

            $docsDb = oneGetDocsDb();

            $stmt = $docsDb->prepare("SELECT id, doc_id, title, type, owner_email, content, created_at, updated_at FROM docs_documents WHERE id = :id AND type = 'spreadsheet' AND is_trashed = 0");
            $stmt->execute([':id' => $docId]);
            $doc = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$doc) return ['error' => 'Spreadsheet not found'];

            // Check ownership or share access
            if (strtolower($doc['owner_email']) !== strtolower($email)) {
                $sCheck = $docsDb->prepare("SELECT permission FROM docs_doc_shares WHERE document_id = :did AND shared_with = :email");
                $sCheck->execute([':did' => $doc['id'], ':email' => strtolower($email)]);
                if (!$sCheck->fetch()) return ['error' => 'No permission to read this spreadsheet'];
            }

            $decoded = json_decode($doc['content'], true);
            $headers = [];
            $rows = [];
            if ($decoded && isset($decoded['sheets'][0])) {
                $sheet = $decoded['sheets'][0];
                $headers = $sheet['headers'] ?? [];
                $rawData = $sheet['data'] ?? [];
                // Only include non-empty rows (limit to 200 rows for readability)
                $rowCount = 0;
                foreach ($rawData as $row) {
                    if ($rowCount >= 200) break;
                    // Skip fully empty rows
                    $hasData = false;
                    foreach ($row as $cell) {
                        if ($cell !== '' && $cell !== null) { $hasData = true; break; }
                    }
                    if ($hasData) {
                        $rows[] = $row;
                        $rowCount++;
                    }
                }
            } elseif ($decoded && is_array($decoded)) {
                // Simple array-of-arrays format
                foreach ($decoded as $row) {
                    if (is_array($row)) $rows[] = $row;
                    if (count($rows) >= 200) break;
                }
            }

            // Build readable table
            $tableText = '';
            if (!empty($headers)) {
                $tableText .= implode(' | ', $headers) . "\n";
                $tableText .= str_repeat('-', 20) . "\n";
            }
            foreach ($rows as $row) {
                $tableText .= implode(' | ', $row) . "\n";
            }

            return [
                'id' => (int)$doc['id'],
                'title' => $doc['title'],
                'headers' => $headers,
                'row_count' => count($rows),
                'table' => $tableText ?: '(empty spreadsheet)',
                'data' => array_slice($rows, 0, 100), // raw data for analysis
            ];
        }

        case 'analyze_data': {
            $docId = (int)($toolInput['document_id'] ?? 0);
            $column = (int)($toolInput['column'] ?? 0);
            $operation = $toolInput['operation'] ?? '';
            $filterCol = isset($toolInput['filter_column']) ? (int)$toolInput['filter_column'] : null;
            $filterVal = $toolInput['filter_value'] ?? null;

            if (!$docId) return ['error' => 'document_id is required'];
            if (!in_array($operation, ['sum', 'average', 'count', 'min', 'max', 'distinct'], true)) {
                return ['error' => 'Invalid operation. Must be: sum, average, count, min, max, distinct'];
            }

            $docsDb = oneGetDocsDb();

            $stmt = $docsDb->prepare("SELECT id, title, type, owner_email, content FROM docs_documents WHERE id = :id AND type = 'spreadsheet' AND is_trashed = 0");
            $stmt->execute([':id' => $docId]);
            $doc = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$doc) return ['error' => 'Spreadsheet not found'];

            // Check ownership or share access
            if (strtolower($doc['owner_email']) !== strtolower($email)) {
                $sCheck = $docsDb->prepare("SELECT permission FROM docs_doc_shares WHERE document_id = :did AND shared_with = :email");
                $sCheck->execute([':did' => $doc['id'], ':email' => strtolower($email)]);
                if (!$sCheck->fetch()) return ['error' => 'No permission to read this spreadsheet'];
            }

            $decoded = json_decode($doc['content'], true);
            $headers = [];
            $rawData = [];
            if ($decoded && isset($decoded['sheets'][0])) {
                $sheet = $decoded['sheets'][0];
                $headers = $sheet['headers'] ?? [];
                $rawData = $sheet['data'] ?? [];
            } elseif ($decoded && is_array($decoded)) {
                $rawData = $decoded;
            }

            // Extract column values (optionally filtered)
            $values = [];
            foreach ($rawData as $row) {
                if (!is_array($row)) continue;
                // Skip empty rows
                $hasData = false;
                foreach ($row as $cell) { if ($cell !== '' && $cell !== null) { $hasData = true; break; } }
                if (!$hasData) continue;

                // Apply filter if specified
                if ($filterCol !== null && $filterVal !== null) {
                    $cellVal = $row[$filterCol] ?? '';
                    if (mb_strtolower((string)$cellVal) !== mb_strtolower($filterVal)) continue;
                }

                $val = $row[$column] ?? '';
                if ($val !== '' && $val !== null) {
                    $values[] = $val;
                }
            }

            if (empty($values) && $operation !== 'count') {
                return ['error' => 'No data found in the specified column' . ($filterVal ? " with filter $filterVal" : '')];
            }

            $columnName = $headers[$column] ?? "Column $column";
            $result = ['column' => $columnName, 'operation' => $operation];

            // Convert to numeric for math operations
            $numericValues = array_map(function($v) {
                return (float)str_replace([',', ' ', 'R$', '$'], ['.', '', '', ''], (string)$v);
            }, $values);

            switch ($operation) {
                case 'sum':
                    $result['result'] = array_sum($numericValues);
                    $result['message'] = "Soma da coluna '$columnName': " . number_format(array_sum($numericValues), 2, ',', '.');
                    break;
                case 'average':
                    $avg = count($numericValues) > 0 ? array_sum($numericValues) / count($numericValues) : 0;
                    $result['result'] = $avg;
                    $result['message'] = "Media da coluna '$columnName': " . number_format($avg, 2, ',', '.');
                    break;
                case 'count':
                    $result['result'] = count($values);
                    $result['message'] = "Total de valores na coluna '$columnName': " . count($values);
                    break;
                case 'min':
                    $result['result'] = min($numericValues);
                    $result['message'] = "Minimo da coluna '$columnName': " . number_format(min($numericValues), 2, ',', '.');
                    break;
                case 'max':
                    $result['result'] = max($numericValues);
                    $result['message'] = "Maximo da coluna '$columnName': " . number_format(max($numericValues), 2, ',', '.');
                    break;
                case 'distinct':
                    $unique = array_unique($values);
                    $result['result'] = array_values($unique);
                    $result['count'] = count($unique);
                    $result['message'] = "Valores distintos na coluna '$columnName': " . implode(', ', array_slice(array_values($unique), 0, 50));
                    break;
            }

            if ($filterVal !== null) {
                $filterColName = $headers[$filterCol] ?? "Column $filterCol";
                $result['filter'] = "$filterColName = $filterVal";
                $result['filtered_rows'] = count($values);
            }

            return $result;
        }

        case 'read_chat_history': {
            $conversationId2 = (int)($toolInput['conversation_id'] ?? 0);
            $limit = min((int)($toolInput['limit'] ?? 20), 50);
            if (!$conversationId2) return ['error' => 'conversation_id is required'];

            $chatDb = new SQLite3('/var/www/mail/data/chat.db');
            $chatDb->busyTimeout(5000);
            $chatDb->exec('PRAGMA journal_mode=WAL');

            // Verify user is a member of this conversation
            $memCheck = $chatDb->prepare("SELECT email FROM conversation_members WHERE conversation_id = :cid AND email = :email");
            $memCheck->bindValue(':cid', $conversationId2);
            $memCheck->bindValue(':email', $email);
            if (!$memCheck->execute()->fetchArray()) {
                $chatDb->close();
                return ['error' => 'You are not a member of this conversation'];
            }

            // Get conversation info
            $convStmt = $chatDb->prepare("SELECT type, name FROM conversations WHERE id = :cid");
            $convStmt->bindValue(':cid', $conversationId2);
            $conv = $convStmt->execute()->fetchArray(SQLITE3_ASSOC);
            $convName = $conv ? ($conv['name'] ?? ($conv['type'] === 'direct' ? 'Direct message' : 'Group')) : 'Unknown';

            // Get recent messages (excluding deleted)
            $msgStmt = $chatDb->prepare("
                SELECT m.sender_email, m.sender_name, m.content, m.type, m.created_at, m.file_name
                FROM messages m
                WHERE m.conversation_id = :cid AND m.deleted_at IS NULL
                ORDER BY m.id DESC
                LIMIT :limit
            ");
            $msgStmt->bindValue(':cid', $conversationId2);
            $msgStmt->bindValue(':limit', $limit);
            $result = $msgStmt->execute();
            $messages = [];
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
                $displayName = $row['sender_name'] ?: explode('@', $row['sender_email'])[0];
                $contentText = $row['content'];
                if ($row['type'] === 'image') $contentText = '[Imagem]' . ($row['file_name'] ? " ({$row['file_name']})" : '');
                elseif ($row['type'] === 'file') $contentText = '[Arquivo: ' . ($row['file_name'] ?: 'unknown') . ']';
                elseif ($row['type'] === 'voice') $contentText = '[Mensagem de voz]';
                elseif ($row['type'] === 'video') $contentText = '[Video]';
                elseif ($row['type'] === 'audio') $contentText = '[Audio]';
                elseif ($row['type'] === 'location') $contentText = '[Localizacao]';
                elseif ($row['type'] === 'contact') $contentText = '[Contato]';
                elseif ($row['type'] === 'system') $contentText = '[Sistema: ' . $contentText . ']';

                $messages[] = [
                    'from' => $displayName,
                    'content' => $contentText,
                    'time' => $row['created_at'],
                ];
            }
            $chatDb->close();

            // Reverse to chronological order
            $messages = array_reverse($messages);

            // Format as readable text
            $chatText = '';
            foreach ($messages as $m) {
                $time = date('d/m H:i', strtotime($m['time']));
                $chatText .= "[$time] {$m['from']}: {$m['content']}\n";
            }

            return [
                'conversation' => $convName,
                'message_count' => count($messages),
                'messages' => $chatText ?: '(no messages)',
            ];
        }

        case 'analyze_photo': {
            $fileId = (int)($toolInput['file_id'] ?? 0);
            $question = trim($toolInput['question'] ?? 'Describe this image in detail.');
            if (!$fileId) return ['error' => 'file_id is required'];

            // Get file from Drive
            $filesDb = new SQLite3('/var/www/mail/data/files.db');
            $filesDb->busyTimeout(3000);
            $stmt = $filesDb->prepare("SELECT id, owner_email, original_name, stored_name, mime_type FROM files WHERE id = :id AND is_trashed = 0");
            $stmt->bindValue(':id', $fileId);
            $file = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
            $filesDb->close();

            if (!$file) return ['error' => 'File not found'];
            if (strtolower($file['owner_email']) !== strtolower($email)) {
                return ['error' => 'No permission to access this file'];
            }

            // Verify it's an image
            $mime = strtolower($file['mime_type']);
            if (!str_starts_with($mime, 'image/') || str_contains($mime, 'svg')) {
                return ['error' => 'File is not a supported image (must be jpg, png, gif, webp)'];
            }

            // Read the file and encode as base64
            $hash = hash('sha256', strtolower(trim($email)));
            $filePath = '/var/www/mail/data/files/' . $hash . '/' . basename($file['stored_name']);
            if (!file_exists($filePath)) return ['error' => 'Image file not found on disk'];

            $imageData = file_get_contents($filePath);
            if ($imageData === false || strlen($imageData) === 0) return ['error' => 'Could not read image file'];

            // Limit to 10MB for API
            if (strlen($imageData) > 10 * 1024 * 1024) return ['error' => 'Image too large (max 10MB)'];

            $base64 = base64_encode($imageData);
            $mimeType = $file['mime_type'];

            // Call OpenAI GPT-4o vision
            $apiKey = oneLoadApiKey();
            if (!$apiKey) return ['error' => 'AI service unavailable'];

            $visionBody = [
                'model' => 'gpt-4o',
                'max_tokens' => 1024,
                'messages' => [
                    [
                        'role' => 'user',
                        'content' => [
                            ['type' => 'text', 'text' => $question],
                            ['type' => 'image_url', 'image_url' => ['url' => "data:{$mimeType};base64,{$base64}", 'detail' => 'auto']],
                        ],
                    ],
                ],
            ];

            $ch = curl_init('https://api.openai.com/v1/chat/completions');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode($visionBody),
                CURLOPT_HTTPHEADER => [
                    'Content-Type: application/json',
                    'Authorization: Bearer ' . $apiKey,
                ],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 45,
            ]);
            $response = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $curlErr = curl_error($ch);
            curl_close($ch);

            if ($curlErr) {
                error_log("[One Vision] Curl error: $curlErr");
                return ['error' => 'Failed to connect to vision service'];
            }

            $data = json_decode($response, true);
            if ($httpCode !== 200 || !isset($data['choices'][0]['message']['content'])) {
                $errMsg = $data['error']['message'] ?? "HTTP $httpCode";
                error_log("[One Vision] Error: $errMsg");
                return ['error' => 'Vision analysis failed'];
            }

            return [
                'file_name' => $file['original_name'],
                'analysis' => $data['choices'][0]['message']['content'],
            ];
        }

        case 'web_search': {
            $query = trim($toolInput['query'] ?? '');
            if (!$query) return ['error' => 'Search query is required'];

            // Use DuckDuckGo HTML API
            $encodedQuery = urlencode($query);
            $url = "https://html.duckduckgo.com/html/?q={$encodedQuery}";

            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 15,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_USERAGENT => 'Mozilla/5.0 (compatible; ChatyyOne/1.0)',
                CURLOPT_HTTPHEADER => ['Accept-Language: pt-BR,pt;q=0.9,en;q=0.8'],
            ]);
            $html = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $curlErr = curl_error($ch);
            curl_close($ch);

            if ($curlErr || $httpCode !== 200 || !$html) {
                error_log("[One Search] Error: " . ($curlErr ?: "HTTP $httpCode"));
                return ['error' => 'Web search failed'];
            }

            // Parse search results from DuckDuckGo HTML
            $results = [];
            // Match result blocks: <a class="result__a" href="...">title</a> and <a class="result__snippet">snippet</a>
            if (preg_match_all('/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/si', $html, $titleMatches, PREG_SET_ORDER)) {
                // Get snippets
                preg_match_all('/<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/si', $html, $snippetMatches, PREG_SET_ORDER);

                $count = min(count($titleMatches), 8);
                for ($j = 0; $j < $count; $j++) {
                    $title = strip_tags($titleMatches[$j][2] ?? '');
                    $link = $titleMatches[$j][1] ?? '';
                    $snippet = strip_tags($snippetMatches[$j][1] ?? '');
                    // DuckDuckGo wraps links in redirects
                    if (preg_match('/uddg=([^&]+)/', $link, $urlMatch)) {
                        $link = urldecode($urlMatch[1]);
                    }
                    $results[] = [
                        'title' => html_entity_decode($title, ENT_QUOTES, 'UTF-8'),
                        'url' => $link,
                        'snippet' => html_entity_decode($snippet, ENT_QUOTES, 'UTF-8'),
                    ];
                }
            }

            if (empty($results)) {
                return ['query' => $query, 'results' => [], 'message' => 'No results found'];
            }

            // Format as readable text
            $textResults = '';
            foreach ($results as $idx => $r) {
                $num = $idx + 1;
                $textResults .= "{$num}. {$r['title']}\n   {$r['snippet']}\n   {$r['url']}\n\n";
            }

            return [
                'query' => $query,
                'result_count' => count($results),
                'results' => $textResults,
            ];
        }

        case 'read_drive_file': {
            $fileId = (int)($toolInput['file_id'] ?? 0);
            if (!$fileId) return ['error' => 'file_id is required'];

            $filesDb = new SQLite3('/var/www/mail/data/files.db');
            $filesDb->busyTimeout(3000);
            $stmt = $filesDb->prepare("SELECT id, owner_email, original_name, stored_name, mime_type, size_bytes FROM files WHERE id = :id AND is_trashed = 0");
            $stmt->bindValue(':id', $fileId);
            $file = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
            $filesDb->close();

            if (!$file) return ['error' => 'File not found'];
            if (strtolower($file['owner_email']) !== strtolower($email)) {
                return ['error' => 'No permission to access this file'];
            }

            // Check if it's a text-based file
            $textMimeTypes = [
                'text/', 'application/json', 'application/xml', 'application/javascript',
                'application/x-javascript', 'application/ecmascript', 'application/typescript',
                'application/sql', 'application/x-yaml', 'application/x-sh',
                'application/csv', 'application/x-csv',
            ];
            $textExtensions = [
                'txt', 'csv', 'json', 'xml', 'html', 'htm', 'md', 'markdown',
                'js', 'ts', 'jsx', 'tsx', 'py', 'php', 'rb', 'java', 'c', 'cpp', 'h',
                'css', 'scss', 'less', 'sql', 'sh', 'bash', 'zsh', 'yaml', 'yml',
                'toml', 'ini', 'cfg', 'conf', 'env', 'log', 'rst', 'tex',
                'r', 'go', 'rs', 'swift', 'kt', 'scala', 'lua', 'pl', 'pm',
            ];

            $mime = strtolower($file['mime_type']);
            $ext = strtolower(pathinfo($file['original_name'], PATHINFO_EXTENSION));
            $isText = false;
            foreach ($textMimeTypes as $prefix) {
                if (str_starts_with($mime, $prefix) || str_contains($mime, $prefix)) {
                    $isText = true;
                    break;
                }
            }
            if (!$isText && in_array($ext, $textExtensions, true)) {
                $isText = true;
            }
            if (!$isText) {
                return ['error' => "File '{$file['original_name']}' is not a text-based file (type: {$file['mime_type']}). For images, use analyze_photo instead."];
            }

            // Limit file size to 1MB for reading
            if ((int)$file['size_bytes'] > 1048576) {
                return ['error' => 'File is too large to read (max 1MB for text files)'];
            }

            $hash = hash('sha256', strtolower(trim($email)));
            $filePath = '/var/www/mail/data/files/' . $hash . '/' . basename($file['stored_name']);
            if (!file_exists($filePath)) return ['error' => 'File not found on disk'];

            $content = file_get_contents($filePath);
            if ($content === false) return ['error' => 'Could not read file'];

            // Truncate for token limits
            $content = mb_substr($content, 0, 8000);

            // Format CSV files as readable tables
            if ($ext === 'csv' || str_contains($mime, 'csv')) {
                $lines = explode("\n", trim($content));
                if (count($lines) > 1) {
                    $delimiter = str_contains($content, "\t") ? "\t" : (substr_count($lines[0], ';') > substr_count($lines[0], ',') ? ';' : ',');
                    $headers = str_getcsv($lines[0], $delimiter);
                    $tableText = implode(' | ', $headers) . "\n";
                    $tableText .= str_repeat('---', count($headers)) . "\n";
                    $rowCount = 0;
                    for ($ri = 1; $ri < count($lines) && $rowCount < 200; $ri++) {
                        $row = str_getcsv($lines[$ri], $delimiter);
                        if (empty(array_filter($row, fn($c) => $c !== '' && $c !== null))) continue;
                        $tableText .= implode(' | ', $row) . "\n";
                        $rowCount++;
                    }
                    return [
                        'file_name' => $file['original_name'],
                        'mime_type' => $file['mime_type'],
                        'size' => (int)$file['size_bytes'],
                        'format' => 'table',
                        'headers' => $headers,
                        'row_count' => $rowCount,
                        'content' => $tableText,
                    ];
                }
            }

            return [
                'file_name' => $file['original_name'],
                'mime_type' => $file['mime_type'],
                'size' => (int)$file['size_bytes'],
                'content' => $content,
            ];
        }

        case 'find_related_info': {
            $query = trim($toolInput['query'] ?? '');
            if (!$query) return ['error' => 'Query is required'];
            $includeEmails = $toolInput['include_emails'] ?? true;
            $includeCalendar = $toolInput['include_calendar'] ?? true;
            $includeContacts = $toolInput['include_contacts'] ?? true;
            $includeMemories = $toolInput['include_memories'] ?? true;
            $includeChat = $toolInput['include_chat'] ?? true;
            $results = ['query' => $query];

            // 1. Search emails (from/subject)
            if ($includeEmails) {
                $imap = @imap_open("{localhost:993/imap/ssl/novalidate-cert}INBOX", $email, $password);
                if ($imap) {
                    $emailResults = [];
                    $searchQueries = [
                        'FROM "' . addcslashes($query, '"\\') . '"',
                        'SUBJECT "' . addcslashes($query, '"\\') . '"',
                    ];
                    $seenUids = [];
                    foreach ($searchQueries as $sq) {
                        $uids = @imap_search($imap, $sq, SE_UID) ?: [];
                        $uids = array_reverse($uids);
                        foreach (array_slice($uids, 0, 5) as $uid) {
                            if (isset($seenUids[$uid])) continue;
                            $seenUids[$uid] = true;
                            $msgno = imap_msgno($imap, $uid);
                            if (!$msgno) continue;
                            $h = imap_headerinfo($imap, $msgno);
                            $from = isset($h->from[0]) ? (($h->from[0]->personal ?? '') ?: ($h->from[0]->mailbox . '@' . $h->from[0]->host)) : '';
                            $subj = isset($h->subject) ? imap_utf8($h->subject) : '';
                            $date = isset($h->date) ? date('d/m/Y', strtotime($h->date)) : '';
                            $emailResults[] = ['uid' => $uid, 'from' => $from, 'subject' => $subj, 'date' => $date];
                        }
                    }
                    try { imap_close($imap); } catch (\Throwable $e) {}
                    $results['emails'] = array_slice($emailResults, 0, 10);
                    $results['email_count'] = count($emailResults);
                }
            }

            // 2. Search calendar events
            if ($includeCalendar) {
                $calDb = new SQLite3('/var/www/mail/data/calendar.db');
                $calDb->busyTimeout(3000);
                $stmt = $calDb->prepare("SELECT id, title, description, location, start_at, end_at FROM events WHERE user_email=:email AND (title LIKE :q OR description LIKE :q2 OR location LIKE :q3) ORDER BY start_at DESC LIMIT 10");
                $stmt->bindValue(':email', $email);
                $stmt->bindValue(':q', "%$query%");
                $stmt->bindValue(':q2', "%$query%");
                $stmt->bindValue(':q3', "%$query%");
                $res = $stmt->execute();
                $calEvents = [];
                while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
                    $calEvents[] = $row;
                }
                $calDb->close();
                $results['calendar_events'] = $calEvents;
                $results['calendar_count'] = count($calEvents);
            }

            // 3. Search contacts
            if ($includeContacts) {
                $parts = explode('@', $email);
                $contactsFile = "/var/mail/vhosts/{$parts[1]}/{$parts[0]}/contacts.json";
                $matchedContacts = [];
                if (file_exists($contactsFile)) {
                    $contacts = json_decode(file_get_contents($contactsFile), true) ?: [];
                    foreach ($contacts as $c) {
                        if (stripos($c['name'] ?? '', $query) !== false || stripos($c['email'] ?? '', $query) !== false || stripos($c['phone'] ?? '', $query) !== false || stripos($c['company'] ?? '', $query) !== false) {
                            $matchedContacts[] = $c;
                        }
                    }
                }
                $results['contacts'] = array_slice($matchedContacts, 0, 5);
                $results['contact_count'] = count($matchedContacts);
            }

            // 4. Search memories
            if ($includeMemories) {
                $db = oneGetDb();
                $stmt = $db->prepare("SELECT category, key, value FROM one_memory WHERE user_email=:email AND (key LIKE :q OR value LIKE :q2) ORDER BY updated_at DESC LIMIT 10");
                $stmt->bindValue(':email', $email);
                $stmt->bindValue(':q', "%$query%");
                $stmt->bindValue(':q2', "%$query%");
                $res = $stmt->execute();
                $mems = [];
                while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
                    $mems[] = $row;
                }
                $db->close();
                $results['memories'] = $mems;
                $results['memory_count'] = count($mems);
            }

            // 5. Search chat conversations
            if ($includeChat) {
                $chatDb = new SQLite3('/var/www/mail/data/chat.db');
                $chatDb->busyTimeout(5000);
                $chatDb->exec('PRAGMA journal_mode=WAL');
                // Find conversations where the queried person is a member or messages mention them
                $chatResults = [];
                $stmt = $chatDb->prepare("
                    SELECT DISTINCT c.id, c.name, c.type, cm2.email as member_email
                    FROM conversations c
                    JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.email = :email
                    LEFT JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.email != :email2
                    WHERE (cm2.email LIKE :q OR c.name LIKE :q2)
                    ORDER BY c.updated_at DESC LIMIT 5
                ");
                $stmt->bindValue(':email', $email);
                $stmt->bindValue(':email2', $email);
                $stmt->bindValue(':q', "%$query%");
                $stmt->bindValue(':q2', "%$query%");
                $res = $stmt->execute();
                while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
                    $chatResults[] = $row;
                }
                $chatDb->close();
                $results['chat_conversations'] = $chatResults;
                $results['chat_count'] = count($chatResults);
            }

            // Build summary
            $totalResults = ($results['email_count'] ?? 0) + ($results['calendar_count'] ?? 0) + ($results['contact_count'] ?? 0) + ($results['memory_count'] ?? 0) + ($results['chat_count'] ?? 0);
            $results['total_results'] = $totalResults;
            $results['summary'] = "Encontrei {$totalResults} resultados sobre '$query' em " . implode(', ', array_filter([
                ($results['email_count'] ?? 0) > 0 ? ($results['email_count'] . ' emails') : null,
                ($results['calendar_count'] ?? 0) > 0 ? ($results['calendar_count'] . ' eventos') : null,
                ($results['contact_count'] ?? 0) > 0 ? ($results['contact_count'] . ' contatos') : null,
                ($results['memory_count'] ?? 0) > 0 ? ($results['memory_count'] . ' memorias') : null,
                ($results['chat_count'] ?? 0) > 0 ? ($results['chat_count'] . ' conversas') : null,
            ]));

            return $results;
        }

        case 'daily_digest': {
            $digest = [];

            // 1. Unread emails
            $imap = @imap_open("{localhost:993/imap/ssl/novalidate-cert}INBOX", $email, $password);
            if ($imap) {
                $unread = imap_search($imap, 'UNSEEN', SE_UID);
                $unreadCount = $unread ? count($unread) : 0;
                $topEmails = [];
                if ($unread) {
                    $recent = array_slice(array_reverse($unread), 0, 5);
                    foreach ($recent as $uid) {
                        $msgno = imap_msgno($imap, $uid);
                        if (!$msgno) continue;
                        $h = imap_headerinfo($imap, $msgno);
                        $from = isset($h->from[0]) ? (($h->from[0]->personal ?? '') ?: ($h->from[0]->mailbox.'@'.$h->from[0]->host)) : '';
                        $subj = isset($h->subject) ? imap_utf8($h->subject) : '(sem assunto)';
                        $topEmails[] = "$from: $subj";
                    }
                }
                try { imap_close($imap); } catch (\Throwable $e) {}
                $digest['unread_count'] = $unreadCount;
                $digest['top_unread'] = $topEmails;
            }

            // 2. Today's events
            $today = date('Y-m-d');
            $tomorrow = date('Y-m-d', strtotime('+1 day'));
            $dayAfter = date('Y-m-d', strtotime('+2 days'));
            $calDb = new SQLite3('/var/www/mail/data/calendar.db');
            $calDb->busyTimeout(3000);
            $stmt = $calDb->prepare("SELECT title, start_at, end_at, location FROM events WHERE user_email=:email AND start_at >= :today AND start_at < :tomorrow ORDER BY start_at ASC LIMIT 10");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':today', $today . 'T00:00:00');
            $stmt->bindValue(':tomorrow', $tomorrow . 'T00:00:00');
            $result = $stmt->execute();
            $todayEvents = [];
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) { $todayEvents[] = $row; }

            // 3. Tomorrow's events
            $stmt2 = $calDb->prepare("SELECT title, start_at, end_at, location FROM events WHERE user_email=:email AND start_at >= :tomorrow AND start_at < :dayafter ORDER BY start_at ASC LIMIT 10");
            $stmt2->bindValue(':email', $email);
            $stmt2->bindValue(':tomorrow', $tomorrow . 'T00:00:00');
            $stmt2->bindValue(':dayafter', $dayAfter . 'T00:00:00');
            $result2 = $stmt2->execute();
            $tomorrowEvents = [];
            while ($row = $result2->fetchArray(SQLITE3_ASSOC)) { $tomorrowEvents[] = $row; }
            $calDb->close();
            $digest['today_events'] = $todayEvents;
            $digest['tomorrow_events'] = $tomorrowEvents;

            // 4. Pending reminders
            $oneDb = oneGetDb();
            $stmt = $oneDb->prepare("SELECT action_data, trigger_at FROM one_scheduled WHERE user_email=:email AND status='pending' AND trigger_at >= :now ORDER BY trigger_at ASC LIMIT 10");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':now', date('Y-m-d\TH:i:s'));
            $result = $stmt->execute();
            $reminders = [];
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
                $data = json_decode($row['action_data'], true);
                $reminders[] = ['message' => $data['message'] ?? '', 'at' => $row['trigger_at']];
            }
            $digest['pending_reminders'] = $reminders;

            // 5. Expenses this month
            $monthStart = date('Y-m-01');
            $monthEnd = date('Y-m-d');
            $stmt = $oneDb->prepare("SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM one_expenses WHERE user_email=:email AND date >= :start AND date <= :end");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':start', $monthStart);
            $stmt->bindValue(':end', $monthEnd);
            $expRow = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
            $digest['expenses_this_month'] = [
                'total' => round((float)($expRow['total'] ?? 0), 2),
                'count' => (int)($expRow['count'] ?? 0),
                'period' => date('M Y'),
            ];

            // 6. Recent top expenses (last 3)
            $stmt = $oneDb->prepare("SELECT amount, description, category, date FROM one_expenses WHERE user_email=:email ORDER BY date DESC LIMIT 3");
            $stmt->bindValue(':email', $email);
            $res = $stmt->execute();
            $recentExp = [];
            while ($row = $res->fetchArray(SQLITE3_ASSOC)) { $recentExp[] = $row; }
            $digest['recent_expenses'] = $recentExp;

            $oneDb->close();

            // 7. Drive storage
            $filesDb = new SQLite3('/var/www/mail/data/files.db');
            $filesDb->busyTimeout(3000);
            $stmt = $filesDb->prepare("SELECT COUNT(*) as file_count, COALESCE(SUM(size_bytes), 0) as total_bytes FROM files WHERE owner_email=:email AND is_trashed=0");
            $stmt->bindValue(':email', $email);
            $row = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
            $filesDb->close();
            $totalBytes = (int)$row['total_bytes'];
            $formatSize = function($bytes) {
                if ($bytes >= 1073741824) return round($bytes / 1073741824, 2) . ' GB';
                if ($bytes >= 1048576) return round($bytes / 1048576, 1) . ' MB';
                return round($bytes / 1024) . ' KB';
            };
            $digest['storage'] = [
                'files' => (int)$row['file_count'],
                'used' => $formatSize($totalBytes),
                'used_bytes' => $totalBytes,
            ];

            return $digest;
        }

        case 'smart_suggest': {
            $limit = min((int)($toolInput['limit'] ?? 15), 20);
            $suggestions = [];

            // Analyze recent unread emails for actionable items
            $imap = @imap_open("{localhost:993/imap/ssl/novalidate-cert}INBOX", $email, $password);
            if ($imap) {
                $uids = imap_search($imap, 'UNSEEN', SE_UID) ?: [];
                $uids = array_reverse($uids);
                $uids = array_slice($uids, 0, $limit);

                foreach ($uids as $uid) {
                    $msgno = imap_msgno($imap, $uid);
                    if (!$msgno) continue;
                    $h = imap_headerinfo($imap, $msgno);
                    $from = isset($h->from[0]) ? (($h->from[0]->personal ?? '') ?: ($h->from[0]->mailbox . '@' . $h->from[0]->host)) : '';
                    $fromEmail = isset($h->from[0]) ? ($h->from[0]->mailbox . '@' . $h->from[0]->host) : '';
                    $subj = isset($h->subject) ? mb_strtolower(imap_utf8($h->subject)) : '';
                    $date = isset($h->date) ? date('Y-m-d', strtotime($h->date)) : '';

                    // Detect event invitations
                    if (preg_match('/(convite|invitation|reuniao|reunião|meeting|encontro|evento|event|agenda)/i', $subj)) {
                        $suggestions[] = [
                            'type' => 'create_event',
                            'priority' => 'high',
                            'email_uid' => $uid,
                            'from' => $from,
                            'subject' => imap_utf8($h->subject ?? ''),
                            'suggestion' => "Email de $from parece ser um convite para evento. Quer que eu crie no calendario?",
                        ];
                    }

                    // Detect bills/payments
                    if (preg_match('/(fatura|boleto|pagamento|payment|invoice|cobranca|cobrança|vencimento|nf-e|nota fiscal|recibo|pix|transferencia)/i', $subj)) {
                        $suggestions[] = [
                            'type' => 'add_expense',
                            'priority' => 'medium',
                            'email_uid' => $uid,
                            'from' => $from,
                            'subject' => imap_utf8($h->subject ?? ''),
                            'suggestion' => "Email de $from parece ser uma fatura/pagamento. Quer que eu registre como despesa?",
                        ];
                    }

                    // Detect deadlines
                    if (preg_match('/(prazo|deadline|urgente|urgent|vence|expira|ultimo dia|last day|asap|importante)/i', $subj)) {
                        $suggestions[] = [
                            'type' => 'create_reminder',
                            'priority' => 'high',
                            'email_uid' => $uid,
                            'from' => $from,
                            'subject' => imap_utf8($h->subject ?? ''),
                            'suggestion' => "Email de $from parece urgente/com prazo. Quer que eu crie um lembrete?",
                        ];
                    }

                    // Detect new contacts worth saving
                    if (preg_match('/(bem-vindo|welcome|cadastro|registro|confirmacao|confirmação)/i', $subj)) {
                        $suggestions[] = [
                            'type' => 'save_contact',
                            'priority' => 'low',
                            'email_uid' => $uid,
                            'from' => $from,
                            'from_email' => $fromEmail,
                            'suggestion' => "Novo remetente: $from ($fromEmail). Quer que eu salve nos contatos?",
                        ];
                    }

                    // Detect emails needing reply
                    if (preg_match('/(responda|responder|reply|aguardo|aguardando|waiting|confirmacao|confirme|confirmar|confirm)/i', $subj)) {
                        $suggestions[] = [
                            'type' => 'reply_email',
                            'priority' => 'high',
                            'email_uid' => $uid,
                            'from' => $from,
                            'subject' => imap_utf8($h->subject ?? ''),
                            'suggestion' => "Email de $from parece aguardar resposta. Quer que eu ajude a responder?",
                        ];
                    }

                    // Detect travel/trips
                    if (preg_match('/(viagem|voo|flight|hotel|booking|reserva|passagem|embarque|check-in|itinerario)/i', $subj)) {
                        $suggestions[] = [
                            'type' => 'create_event',
                            'priority' => 'medium',
                            'email_uid' => $uid,
                            'from' => $from,
                            'subject' => imap_utf8($h->subject ?? ''),
                            'suggestion' => "Email de $from e sobre viagem. Quer que eu adicione ao calendario?",
                        ];
                    }
                }
                try { imap_close($imap); } catch (\Throwable $e) {}
            }

            // Sort by priority
            usort($suggestions, function($a, $b) {
                $prio = ['high' => 0, 'medium' => 1, 'low' => 2];
                return ($prio[$a['priority']] ?? 3) - ($prio[$b['priority']] ?? 3);
            });

            return [
                'suggestions' => array_slice($suggestions, 0, 10),
                'count' => count($suggestions),
                'message' => count($suggestions) > 0
                    ? 'Encontrei ' . count($suggestions) . ' sugestoes baseadas nos seus emails recentes.'
                    : 'Nenhuma sugestao no momento — seus emails parecem tranquilos!',
            ];
        }

        case 'update_brain': {
            $content = $toolInput['content'] ?? '';
            if (!$content) return ['error' => 'Content is required'];
            if (strlen($content) > 50000) {
                $content = mb_substr($content, 0, 50000);
            }
            oneSaveBrain($email, $content);
            return ['success' => true, 'message' => 'Cerebro atualizado com sucesso.', 'size' => strlen($content)];
        }

        case 'read_user_profile': {
            $profile = [];

            // 1. Recent emails (last 20)
            $imap = @imap_open("{localhost:993/imap/ssl/novalidate-cert}INBOX", $email, $password);
            if ($imap) {
                $info = imap_check($imap);
                $total = $info->Nmsgs;
                $start = max(1, $total - 19);
                $recentEmails = [];
                for ($i = $total; $i >= $start; $i--) {
                    $header = @imap_headerinfo($imap, $i);
                    if (!$header) continue;
                    $from = isset($header->from[0]) ? (($header->from[0]->personal ?? '') ?: ($header->from[0]->mailbox . '@' . $header->from[0]->host)) : '';
                    $subject = isset($header->subject) ? imap_utf8($header->subject) : '(sem assunto)';
                    $date = isset($header->date) ? date('Y-m-d H:i', strtotime($header->date)) : '';
                    $seen = isset($header->Unseen) ? ($header->Unseen !== 'U') : true;
                    $recentEmails[] = ['from' => $from, 'subject' => $subject, 'date' => $date, 'read' => $seen];
                }
                try { imap_close($imap); } catch (\Throwable $e) {}
                $profile['recent_emails'] = $recentEmails;
                $profile['email_total'] = $total;
            }

            // 2. Calendar events (upcoming 30 days)
            $calPath = __DIR__ . '/../data/calendar.db';
            if (file_exists($calPath)) {
                try {
                    $calDb = new SQLite3($calPath);
                    $calDb->busyTimeout(3000);
                    $now = date('Y-m-d\TH:i:s');
                    $future = date('Y-m-d\TH:i:s', strtotime('+30 days'));
                    $st = $calDb->prepare("SELECT title, start_at, end_at, location, description FROM events WHERE user_email=:email AND start_at >= :now AND start_at <= :future ORDER BY start_at LIMIT 30");
                    $st->bindValue(':email', $email);
                    $st->bindValue(':now', $now);
                    $st->bindValue(':future', $future);
                    $res = $st->execute();
                    $events = [];
                    while ($row = $res->fetchArray(SQLITE3_ASSOC)) { $events[] = $row; }
                    $profile['calendar_events'] = $events;
                    $calDb->close();
                } catch (\Throwable $e) { $profile['calendar_events'] = []; }
            }

            // 3. Contacts
            $userParts = explode('@', $email);
            $contactsFile = '/var/mail/vhosts/' . basename($userParts[1]) . '/' . basename($userParts[0]) . '/data.json';
            if (file_exists($contactsFile)) {
                $data = json_decode(file_get_contents($contactsFile), true);
                if (isset($data['contacts'])) {
                    $contacts = [];
                    foreach (array_slice($data['contacts'], 0, 100) as $c) {
                        $contacts[] = ['name' => $c['name'] ?? '', 'email' => $c['email'] ?? '', 'phone' => $c['phone'] ?? '', 'group' => $c['group'] ?? ''];
                    }
                    $profile['contacts'] = $contacts;
                }
            }

            // 4. Drive files (recent 50)
            $filesPath = __DIR__ . '/../data/files.db';
            if (file_exists($filesPath)) {
                try {
                    $filesDb = new SQLite3($filesPath);
                    $filesDb->busyTimeout(3000);
                    $st = $filesDb->prepare("SELECT name, mime_type, size, created_at FROM files WHERE user_email=:email AND is_trashed=0 ORDER BY created_at DESC LIMIT 50");
                    $st->bindValue(':email', $email);
                    $res = $st->execute();
                    $files = [];
                    while ($row = $res->fetchArray(SQLITE3_ASSOC)) { $files[] = $row; }
                    $profile['drive_files'] = $files;

                    $st2 = $filesDb->prepare("SELECT COUNT(*) as cnt FROM files WHERE user_email=:email AND is_trashed=0 AND mime_type LIKE 'image/%'");
                    $st2->bindValue(':email', $email);
                    $r2 = $st2->execute()->fetchArray(SQLITE3_ASSOC);
                    $profile['photo_count'] = $r2['cnt'] ?? 0;

                    $st3 = $filesDb->prepare("SELECT COALESCE(SUM(size),0) as total FROM files WHERE user_email=:email AND is_trashed=0");
                    $st3->bindValue(':email', $email);
                    $r3 = $st3->execute()->fetchArray(SQLITE3_ASSOC);
                    $profile['storage_bytes'] = $r3['total'] ?? 0;
                    $profile['storage_human'] = round(($r3['total'] ?? 0) / (1024*1024), 1) . ' MB';

                    $filesDb->close();
                } catch (\Throwable $e) { $profile['drive_files'] = []; }
            }

            // 5. Documents (recent 20)
            try {
                $docsDb = oneGetDocsDb();
                $st = $docsDb->prepare("SELECT id, title, type, created_at, updated_at FROM docs_documents WHERE owner_email=:email AND is_trashed = 0 ORDER BY updated_at DESC LIMIT 20");
                $st->execute([':email' => $email]);
                $profile['documents'] = $st->fetchAll(PDO::FETCH_ASSOC);
            } catch (\Throwable $e) { $profile['documents'] = []; }

            // 6. Chat conversations (last 10)
            $chatPath = __DIR__ . '/../data/chat.db';
            if (file_exists($chatPath)) {
                try {
                    $chatDb = new SQLite3($chatPath);
                    $chatDb->busyTimeout(3000);
                    $st = $chatDb->prepare("SELECT c.id, c.name, c.is_group, c.updated_at,
                        (SELECT content FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) as last_message
                        FROM conversations c
                        JOIN conversation_members cm ON cm.conversation_id=c.id
                        WHERE cm.user_email=:email
                        ORDER BY c.updated_at DESC LIMIT 10");
                    $st->bindValue(':email', $email);
                    $res = $st->execute();
                    $chats = [];
                    while ($row = $res->fetchArray(SQLITE3_ASSOC)) { $chats[] = $row; }
                    $profile['chat_conversations'] = $chats;
                    $chatDb->close();
                } catch (\Throwable $e) { $profile['chat_conversations'] = []; }
            }

            // 7. Expenses (last 30 days)
            $oneDb = oneGetDb();
            $start30 = date('Y-m-d', strtotime('-30 days'));
            $st = $oneDb->prepare("SELECT amount, category, description, date FROM one_expenses WHERE user_email=:email AND date >= :start ORDER BY date DESC LIMIT 50");
            $st->bindValue(':email', $email);
            $st->bindValue(':start', $start30);
            $res = $st->execute();
            $expenses = [];
            $expenseTotal = 0;
            while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
                $expenses[] = $row;
                $expenseTotal += $row['amount'];
            }
            $profile['expenses_30d'] = $expenses;
            $profile['expenses_30d_total'] = $expenseTotal;

            // 8. Saved memories
            $st = $oneDb->prepare("SELECT category, key, value FROM one_memory WHERE user_email=:email ORDER BY category, key");
            $st->bindValue(':email', $email);
            $res = $st->execute();
            $mems = [];
            while ($row = $res->fetchArray(SQLITE3_ASSOC)) { $mems[] = $row; }
            $profile['memories'] = $mems;
            $oneDb->close();

            // 9. Current brain content
            $profile['current_brain'] = oneLoadBrain($email);

            return [
                'profile' => $profile,
                'message' => 'Perfil completo do usuario carregado. Use essas informacoes para construir/atualizar o cerebro.',
            ];
        }

        case 'translate': {
            $text = trim($toolInput['text'] ?? '');
            $from = trim($toolInput['from'] ?? 'auto');
            $to = trim($toolInput['to'] ?? '');
            if (!$text || !$to) return ['error' => 'Text and target language required'];
            if (mb_strlen($text) > 5000) $text = mb_substr($text, 0, 5000);

            $apiKey = oneLoadApiKey();
            if (!$apiKey) return ['error' => 'AI service unavailable'];

            $prompt = $from === 'auto'
                ? "Translate the following text to {$to}. Return ONLY the translated text, nothing else:\n\n{$text}"
                : "Translate the following text from {$from} to {$to}. Return ONLY the translated text, nothing else:\n\n{$text}";

            $ch = curl_init('https://api.openai.com/v1/chat/completions');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode([
                    'model' => 'gpt-4o-mini',
                    'max_tokens' => 2048,
                    'temperature' => 0.3,
                    'messages' => [
                        ['role' => 'system', 'content' => 'You are a professional translator. Return ONLY the translated text with no explanations, notes, or formatting.'],
                        ['role' => 'user', 'content' => $prompt],
                    ],
                ]),
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $apiKey],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 30,
            ]);
            $response = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            if ($httpCode !== 200) {
                error_log("[One Translate] OpenAI HTTP $httpCode");
                return ['error' => 'Translation service unavailable'];
            }

            $data = json_decode($response, true);
            $translated = $data['choices'][0]['message']['content'] ?? '';
            if (!$translated) return ['error' => 'Translation failed'];

            return [
                'original' => $text,
                'translated' => trim($translated),
                'from' => $from,
                'to' => $to,
                'message' => "Traducao para {$to} concluida.",
            ];
        }

        case 'calculate': {
            $expression = trim($toolInput['expression'] ?? '');
            $type = $toolInput['type'] ?? 'math';
            if (!$expression) return ['error' => 'Expression required'];

            $apiKey = oneLoadApiKey();
            if (!$apiKey) return ['error' => 'AI service unavailable'];

            $calcPrompt = "You are a precise calculator. Solve the following calculation and return a JSON object with the result.\n\n"
                . "Input: {$expression}\nType: {$type}\n\n"
                . "Return a JSON object like: {\"result\": <number or string>, \"explanation\": \"<brief step-by-step>\", \"formatted\": \"<human-readable result with units>\"}\n"
                . "For currency conversions, use approximate current rates. For percentage, show the calculation. For compound interest, show final amount and total interest.\n"
                . "IMPORTANT: Return ONLY valid JSON, no markdown, no code blocks.";

            $ch = curl_init('https://api.openai.com/v1/chat/completions');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode([
                    'model' => 'gpt-4o-mini',
                    'max_tokens' => 512,
                    'temperature' => 0.1,
                    'messages' => [
                        ['role' => 'system', 'content' => 'You are a precise calculator. Return only valid JSON.'],
                        ['role' => 'user', 'content' => $calcPrompt],
                    ],
                ]),
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $apiKey],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 15,
            ]);
            $response = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            if ($httpCode !== 200) {
                error_log("[One Calculate] OpenAI HTTP $httpCode");
                return ['error' => 'Calculation service unavailable'];
            }

            $data = json_decode($response, true);
            $content = $data['choices'][0]['message']['content'] ?? '';
            // Strip markdown code block if present
            $content = preg_replace('/^```json\s*/', '', $content);
            $content = preg_replace('/\s*```$/', '', $content);
            $calcResult = json_decode(trim($content), true);
            if (!$calcResult) {
                return ['expression' => $expression, 'result' => $content, 'message' => $content];
            }

            return [
                'expression' => $expression,
                'result' => $calcResult['result'] ?? '',
                'explanation' => $calcResult['explanation'] ?? '',
                'formatted' => $calcResult['formatted'] ?? '',
                'message' => $calcResult['formatted'] ?? json_encode($calcResult['result'] ?? ''),
            ];
        }

        case 'analyze_email': {
            $uid = $toolInput['uid'] ?? 0;
            $folder = oneSanitizeFolder($toolInput['folder'] ?? 'INBOX');
            if (!$uid) return ['error' => 'UID required'];

            // Read the email
            $imap = @imap_open("{localhost:993/imap/ssl/novalidate-cert}$folder", $email, $password);
            if (!$imap) return ['error' => 'Could not connect to mailbox'];

            $msgno = imap_msgno($imap, $uid);
            if (!$msgno) { try { imap_close($imap); } catch (\Throwable $e) {} return ['error' => 'Email not found']; }

            $header = imap_headerinfo($imap, $msgno);
            $body = imap_fetchbody($imap, $msgno, '1');
            $struct = imap_fetchstructure($imap, $msgno);
            $encoding = null;
            if ($struct && isset($struct->parts[0])) {
                $encoding = $struct->parts[0]->encoding;
            } elseif ($struct) {
                $encoding = $struct->encoding;
            }
            if ($encoding === 3) $body = base64_decode($body);
            elseif ($encoding === 4) $body = quoted_printable_decode($body);
            $body = strip_tags($body);
            $body = mb_substr(trim($body), 0, 4000);

            $from = isset($header->from[0]) ? (($header->from[0]->personal ?? '') ?: ($header->from[0]->mailbox . '@' . $header->from[0]->host)) : '';
            $fromEmail = isset($header->from[0]) ? ($header->from[0]->mailbox . '@' . $header->from[0]->host) : '';
            $subject = isset($header->subject) ? imap_utf8($header->subject) : '';
            $date = isset($header->date) ? date('Y-m-d H:i', strtotime($header->date)) : '';
            $toAddr = isset($header->to[0]) ? ($header->to[0]->mailbox . '@' . ($header->to[0]->host ?? '')) : '';

            // Collect CC recipients
            $ccList = [];
            if (!empty($header->cc)) {
                foreach ($header->cc as $cc) {
                    $ccList[] = ($cc->personal ?? '') ?: ($cc->mailbox . '@' . ($cc->host ?? ''));
                }
            }

            try { imap_close($imap); } catch (\Throwable $e) {}

            // Use AI to analyze
            $apiKey = oneLoadApiKey();
            if (!$apiKey) return ['error' => 'AI service unavailable'];

            $analysisPrompt = "Analyze this email in detail. Return a JSON object with:\n"
                . "- summary: 2-3 sentence summary in Portuguese\n"
                . "- sentiment: 'positive', 'negative', or 'neutral'\n"
                . "- urgency: 'high', 'medium', or 'low'\n"
                . "- action_items: array of action items extracted (in Portuguese)\n"
                . "- deadlines: array of any deadlines or dates mentioned\n"
                . "- people_mentioned: array of names mentioned in the email\n"
                . "- suggested_actions: array of what the user should do (in Portuguese)\n"
                . "- tone: 'formal', 'informal', 'urgent', 'friendly', 'cold'\n"
                . "- needs_reply: boolean\n\n"
                . "From: {$from} ({$fromEmail})\n"
                . "To: {$toAddr}\n"
                . ($ccList ? "CC: " . implode(', ', $ccList) . "\n" : "")
                . "Subject: {$subject}\n"
                . "Date: {$date}\n\n"
                . "Body:\n{$body}\n\n"
                . "IMPORTANT: Return ONLY valid JSON, no markdown.";

            $ch = curl_init('https://api.openai.com/v1/chat/completions');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode([
                    'model' => 'gpt-4o-mini',
                    'max_tokens' => 1024,
                    'temperature' => 0.3,
                    'messages' => [
                        ['role' => 'system', 'content' => 'You are an email analyst. Return only valid JSON.'],
                        ['role' => 'user', 'content' => $analysisPrompt],
                    ],
                ]),
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $apiKey],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 30,
            ]);
            $response = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            if ($httpCode !== 200) {
                error_log("[One AnalyzeEmail] OpenAI HTTP $httpCode");
                return ['error' => 'Email analysis failed'];
            }

            $data = json_decode($response, true);
            $content = $data['choices'][0]['message']['content'] ?? '';
            $content = preg_replace('/^```json\s*/', '', $content);
            $content = preg_replace('/\s*```$/', '', $content);
            $analysis = json_decode(trim($content), true);

            if (!$analysis) {
                return ['uid' => $uid, 'from' => $from, 'subject' => $subject, 'analysis' => $content];
            }

            return array_merge([
                'uid' => $uid,
                'from' => $from,
                'from_email' => $fromEmail,
                'subject' => $subject,
                'date' => $date,
            ], $analysis);
        }

        case 'schedule_whatsapp': {
            $to = trim($toolInput['to'] ?? '');
            $msg = trim($toolInput['message'] ?? '');
            $sendAt = trim($toolInput['send_at'] ?? '');
            if (!$to || !$msg || !$sendAt) return ['error' => 'Phone number, message, and send_at required'];

            // Normalize phone
            $to = preg_replace('/[^+0-9]/', '', $to);
            if (!str_starts_with($to, '+')) $to = '+55' . $to;
            if (!preg_match('/^\+[1-9]\d{6,14}$/', $to)) return ['error' => 'Invalid phone number format'];

            $sendTs = strtotime($sendAt);
            if (!$sendTs || $sendTs <= time()) return ['error' => 'send_at must be a future datetime'];

            $db = oneGetDb();
            $stmt = $db->prepare("INSERT INTO one_scheduled (user_email, action_type, action_data, trigger_at) VALUES (:email, 'scheduled_whatsapp', :data, :trigger)");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':data', json_encode(['to' => $to, 'content' => $msg, 'message_type' => 'whatsapp']));
            $stmt->bindValue(':trigger', date('Y-m-d\TH:i:s', $sendTs));
            $stmt->execute();
            $schedId = $db->lastInsertRowID();
            $db->close();

            return [
                'success' => true,
                'id' => $schedId,
                'message' => "WhatsApp agendado para $to em " . date('d/m/Y H:i', $sendTs),
            ];
        }

        case 'delete_expense': {
            $expId = (int)($toolInput['expense_id'] ?? 0);
            if (!$expId) return ['error' => 'expense_id required'];
            $db = oneGetDb();
            // Verify ownership
            $stmt = $db->prepare("SELECT id, amount, description FROM one_expenses WHERE id=:id AND user_email=:email");
            $stmt->bindValue(':id', $expId);
            $stmt->bindValue(':email', $email);
            $row = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
            if (!$row) { $db->close(); return ['error' => 'Despesa nao encontrada']; }

            $delStmt = $db->prepare("DELETE FROM one_expenses WHERE id=:id AND user_email=:email");
            $delStmt->bindValue(':id', $expId);
            $delStmt->bindValue(':email', $email);
            $delStmt->execute();
            $db->close();

            return ['success' => true, 'message' => "Despesa removida: R$ " . number_format($row['amount'], 2, ',', '.') . " ({$row['description']})"];
        }

        case 'list_scheduled': {
            $db = oneGetDb();
            $stmt = $db->prepare("SELECT id, action_type, action_data, trigger_at, status FROM one_scheduled WHERE user_email=:email AND status='pending' ORDER BY trigger_at ASC LIMIT 20");
            $stmt->bindValue(':email', $email);
            $result = $stmt->execute();
            $items = [];
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
                $data = json_decode($row['action_data'], true) ?: [];
                $items[] = [
                    'id' => (int)$row['id'],
                    'type' => $row['action_type'],
                    'message' => $data['message'] ?? $data['content'] ?? '',
                    'to' => $data['to'] ?? $data['phone'] ?? '',
                    'delivery' => $data['delivery'] ?? $data['message_type'] ?? '',
                    'scheduled_for' => $row['trigger_at'],
                    'scheduled_for_human' => date('d/m/Y H:i', strtotime($row['trigger_at'])),
                ];
            }
            $db->close();
            return ['scheduled' => $items, 'count' => count($items), 'message' => count($items) > 0 ? count($items) . ' itens agendados' : 'Nenhum item agendado'];
        }

        case 'cancel_scheduled': {
            $schedId = (int)($toolInput['scheduled_id'] ?? 0);
            if (!$schedId) return ['error' => 'scheduled_id required'];
            $db = oneGetDb();
            $stmt = $db->prepare("UPDATE one_scheduled SET status='cancelled' WHERE id=:id AND user_email=:email AND status='pending'");
            $stmt->bindValue(':id', $schedId);
            $stmt->bindValue(':email', $email);
            $stmt->execute();
            $changes = $db->changes();
            $db->close();
            return $changes > 0 ? ['success' => true, 'message' => 'Item agendado cancelado!'] : ['error' => 'Item nao encontrado ou ja executado'];
        }

        // ═══════════════════════════════════════════
        // NEW TOOL HANDLERS
        // ═══════════════════════════════════════════

        case 'send_whatsapp_image': {
            $to = $toolInput['to'] ?? '';
            $imageUrl = $toolInput['image_url'] ?? '';
            $caption = $toolInput['caption'] ?? '';
            if (!$to || !$imageUrl) return ['error' => 'Phone number and image URL required'];

            $normalizedTo = preg_replace('/[^+0-9]/', '', $to);
            if (!str_starts_with($normalizedTo, '+')) $normalizedTo = '+55' . $normalizedTo;
            if (!preg_match('/^\+[1-9]\d{6,14}$/', $normalizedTo)) return ['error' => 'Invalid phone number'];
            if (!filter_var($imageUrl, FILTER_VALIDATE_URL)) return ['error' => 'Invalid image URL'];

            // Load Twilio credentials
            $sid = $token = $from = '';
            if (file_exists('/etc/mail-api.env')) {
                foreach (file('/etc/mail-api.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                    if (strpos($line, '#') === 0) continue;
                    if (strpos($line, 'TWILIO_ACCOUNT_SID=') === 0) $sid = substr($line, strlen('TWILIO_ACCOUNT_SID='));
                    if (strpos($line, 'TWILIO_AUTH_TOKEN=') === 0) $token = substr($line, strlen('TWILIO_AUTH_TOKEN='));
                    if (strpos($line, 'TWILIO_WHATSAPP_NUMBER=') === 0) $from = substr($line, strlen('TWILIO_WHATSAPP_NUMBER='));
                }
            }
            if (!$sid || !$token || !$from) return ['error' => 'Twilio WhatsApp not configured'];

            $postData = [
                'To' => 'whatsapp:' . $normalizedTo,
                'From' => $from,
                'MediaUrl' => $imageUrl,
            ];
            if ($caption) $postData['Body'] = $caption;

            $url = "https://api.twilio.com/2010-04-01/Accounts/$sid/Messages.json";
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => http_build_query($postData),
                CURLOPT_USERPWD => "$sid:$token",
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 15,
            ]);
            $response = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            $data = json_decode($response, true);
            if ($httpCode >= 200 && $httpCode < 300 && isset($data['sid'])) {
                return ['success' => true, 'message' => "Imagem enviada via WhatsApp para $normalizedTo"];
            }
            return ['error' => 'Failed to send image: ' . ($data['message'] ?? "HTTP $httpCode")];
        }

        case 'send_whatsapp_audio': {
            $to = $toolInput['to'] ?? '';
            $audioUrl = $toolInput['audio_url'] ?? '';
            if (!$to || !$audioUrl) return ['error' => 'Phone number and audio URL required'];

            $normalizedTo = preg_replace('/[^+0-9]/', '', $to);
            if (!str_starts_with($normalizedTo, '+')) $normalizedTo = '+55' . $normalizedTo;
            if (!preg_match('/^\+[1-9]\d{6,14}$/', $normalizedTo)) return ['error' => 'Invalid phone number'];
            if (!filter_var($audioUrl, FILTER_VALIDATE_URL)) return ['error' => 'Invalid audio URL'];

            $sid = $token = $from = '';
            if (file_exists('/etc/mail-api.env')) {
                foreach (file('/etc/mail-api.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                    if (strpos($line, '#') === 0) continue;
                    if (strpos($line, 'TWILIO_ACCOUNT_SID=') === 0) $sid = substr($line, strlen('TWILIO_ACCOUNT_SID='));
                    if (strpos($line, 'TWILIO_AUTH_TOKEN=') === 0) $token = substr($line, strlen('TWILIO_AUTH_TOKEN='));
                    if (strpos($line, 'TWILIO_WHATSAPP_NUMBER=') === 0) $from = substr($line, strlen('TWILIO_WHATSAPP_NUMBER='));
                }
            }
            if (!$sid || !$token || !$from) return ['error' => 'Twilio WhatsApp not configured'];

            $url = "https://api.twilio.com/2010-04-01/Accounts/$sid/Messages.json";
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => http_build_query([
                    'To' => 'whatsapp:' . $normalizedTo,
                    'From' => $from,
                    'MediaUrl' => $audioUrl,
                ]),
                CURLOPT_USERPWD => "$sid:$token",
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 15,
            ]);
            $response = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            $data = json_decode($response, true);
            if ($httpCode >= 200 && $httpCode < 300 && isset($data['sid'])) {
                return ['success' => true, 'message' => "Audio enviado via WhatsApp para $normalizedTo"];
            }
            return ['error' => 'Failed to send audio: ' . ($data['message'] ?? "HTTP $httpCode")];
        }

        case 'send_email_html': {
            $to = str_replace(["\r", "\n"], '', $toolInput['to'] ?? '');
            $subject = str_replace(["\r", "\n"], '', $toolInput['subject'] ?? '');
            $htmlBody = $toolInput['html_body'] ?? '';
            $textBody = $toolInput['text_body'] ?? strip_tags($htmlBody);
            if (!$to || !$subject || !$htmlBody) return ['error' => 'to, subject, and html_body required'];

            $boundary = '----=_Part_' . uniqid('', true);
            $encodedSubject = preg_match('/[^\x20-\x7E]/', $subject) ? '=?UTF-8?B?' . base64_encode($subject) . '?=' : $subject;

            $mime = "From: {$email}\r\n";
            $mime .= "To: {$to}\r\n";
            $mime .= "Subject: {$encodedSubject}\r\n";
            $mime .= "Date: " . date('r') . "\r\n";
            $mime .= "Message-ID: <" . uniqid('one_html_', true) . "@" . explode('@', $email)[1] . ">\r\n";
            $mime .= "MIME-Version: 1.0\r\n";
            $mime .= "Content-Type: multipart/alternative; boundary=\"{$boundary}\"\r\n";
            $mime .= "X-Mailer: Chatyy One AI/1.0\r\n";
            $mime .= "\r\n";
            $mime .= "--{$boundary}\r\n";
            $mime .= "Content-Type: text/plain; charset=UTF-8\r\n";
            $mime .= "Content-Transfer-Encoding: quoted-printable\r\n\r\n";
            $mime .= quoted_printable_encode($textBody) . "\r\n";
            $mime .= "--{$boundary}\r\n";
            $mime .= "Content-Type: text/html; charset=UTF-8\r\n";
            $mime .= "Content-Transfer-Encoding: quoted-printable\r\n\r\n";
            $mime .= quoted_printable_encode($htmlBody) . "\r\n";
            $mime .= "--{$boundary}--\r\n";

            $recipients = array_filter(array_map('trim', explode(',', $to)));
            $cmd = '/usr/sbin/sendmail -oi -f ' . escapeshellarg($email);
            foreach ($recipients as $rcpt) {
                if (filter_var($rcpt, FILTER_VALIDATE_EMAIL)) $cmd .= ' ' . escapeshellarg($rcpt);
            }
            $proc = proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            if (!is_resource($proc)) return ['error' => 'Failed to start sendmail'];
            fwrite($pipes[0], $mime); fclose($pipes[0]); fclose($pipes[1]);
            $stderr = stream_get_contents($pipes[2]); fclose($pipes[2]);
            $exitCode = proc_close($proc);

            if ($exitCode === 0) {
                $imap = @imap_open("{localhost:993/imap/ssl/novalidate-cert}INBOX", $email, $password);
                if ($imap) {
                    @imap_append($imap, "{localhost:993/imap/ssl/novalidate-cert}Sent", $mime, "\\Seen");
                    try { @imap_close($imap); } catch (\Throwable $e) {}
                }
                return ['success' => true, 'message' => "Email HTML enviado para $to"];
            }
            return ['error' => 'Failed to send HTML email: ' . $stderr];
        }

        case 'forward_email': {
            $uid = (int)($toolInput['uid'] ?? 0);
            $to = str_replace(["\r", "\n"], '', $toolInput['to'] ?? '');
            $folder = oneSanitizeFolder($toolInput['folder'] ?? 'INBOX');
            $comment = $toolInput['comment'] ?? '';
            if (!$uid || !$to) return ['error' => 'uid and to required'];

            $imap = @imap_open("{localhost:993/imap/ssl/novalidate-cert}$folder", $email, $password);
            if (!$imap) return ['error' => 'Could not connect to mailbox'];

            $overview = @imap_fetch_overview($imap, (string)$uid, FT_UID);
            if (!$overview) { try { @imap_close($imap); } catch (\Throwable $e) {} return ['error' => 'Email not found']; }
            $ov = $overview[0];
            $origSubject = isset($ov->subject) ? iconv_mime_decode($ov->subject, 0, 'UTF-8') : '(no subject)';
            $origFrom = isset($ov->from) ? iconv_mime_decode($ov->from, 0, 'UTF-8') : '';
            $origDate = $ov->date ?? '';
            $body = @imap_fetchbody($imap, $uid, '1', FT_UID) ?: @imap_body($imap, $uid, FT_UID) ?: '';
            $struct = @imap_fetchstructure($imap, $uid, FT_UID);
            if ($struct && isset($struct->encoding)) {
                if ($struct->encoding == 3) $body = base64_decode($body);
                elseif ($struct->encoding == 4) $body = quoted_printable_decode($body);
            }
            try { @imap_close($imap); } catch (\Throwable $e) {}

            $fwdSubject = "Fwd: $origSubject";
            $fwdBody = "";
            if ($comment) $fwdBody .= "$comment\n\n";
            $fwdBody .= "---------- Forwarded message ----------\n";
            $fwdBody .= "From: $origFrom\n";
            $fwdBody .= "Date: $origDate\n";
            $fwdBody .= "Subject: $origSubject\n\n";
            $fwdBody .= $body;

            $encodedSubject = preg_match('/[^\x20-\x7E]/', $fwdSubject) ? '=?UTF-8?B?' . base64_encode($fwdSubject) . '?=' : $fwdSubject;
            $mime = "From: {$email}\r\nTo: {$to}\r\nSubject: {$encodedSubject}\r\n";
            $mime .= "Date: " . date('r') . "\r\nMessage-ID: <" . uniqid('one_fwd_', true) . "@" . explode('@', $email)[1] . ">\r\n";
            $mime .= "MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n";
            $mime .= "X-Mailer: Chatyy One AI/1.0\r\n\r\n";
            $mime .= quoted_printable_encode($fwdBody);

            $cmd = '/usr/sbin/sendmail -oi -f ' . escapeshellarg($email) . ' ' . escapeshellarg($to);
            $proc = proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            if (!is_resource($proc)) return ['error' => 'Failed to start sendmail'];
            fwrite($pipes[0], $mime); fclose($pipes[0]); fclose($pipes[1]);
            $stderr = stream_get_contents($pipes[2]); fclose($pipes[2]);
            $exitCode = proc_close($proc);

            if ($exitCode === 0) {
                $imap2 = @imap_open("{localhost:993/imap/ssl/novalidate-cert}INBOX", $email, $password);
                if ($imap2) { @imap_append($imap2, "{localhost:993/imap/ssl/novalidate-cert}Sent", $mime, "\\Seen"); try { @imap_close($imap2); } catch (\Throwable $e) {} }
                return ['success' => true, 'message' => "Email encaminhado para $to: \"$origSubject\""];
            }
            return ['error' => 'Failed to forward: ' . $stderr];
        }

        case 'create_task': {
            $title = trim($toolInput['title'] ?? '');
            if (!$title) return ['error' => 'Task title required'];
            $desc = trim($toolInput['description'] ?? '');
            $dueDate = $toolInput['due_date'] ?? null;
            $priority = in_array($toolInput['priority'] ?? '', ['high','medium','low']) ? $toolInput['priority'] : 'medium';
            $category = trim($toolInput['category'] ?? 'general');
            $assignee = trim($toolInput['assignee'] ?? '');

            $db = oneGetDb();
            $stmt = $db->prepare("INSERT INTO one_tasks (user_email, title, description, due_date, priority, category, assignee) VALUES (:email, :title, :desc, :due, :pri, :cat, :assign)");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':title', $title);
            $stmt->bindValue(':desc', $desc);
            $stmt->bindValue(':due', $dueDate);
            $stmt->bindValue(':pri', $priority);
            $stmt->bindValue(':cat', $category);
            $stmt->bindValue(':assign', $assignee);
            $stmt->execute();
            $taskId = $db->lastInsertRowID();
            $db->close();

            $msg = "Tarefa criada: \"{$title}\"";
            if ($dueDate) $msg .= " (vence " . date('d/m/Y', strtotime($dueDate)) . ")";
            $priorityLabels = ['high' => 'alta', 'medium' => 'media', 'low' => 'baixa'];
            $msg .= " [prioridade {$priorityLabels[$priority]}]";
            return ['success' => true, 'id' => $taskId, 'message' => $msg];
        }

        case 'list_tasks': {
            $status = $toolInput['status'] ?? 'pending';
            $priority = $toolInput['priority'] ?? null;
            $category = $toolInput['category'] ?? null;
            $limit = min((int)($toolInput['limit'] ?? 20), 50);

            $db = oneGetDb();
            $sql = "SELECT * FROM one_tasks WHERE user_email=:email";
            if ($status !== 'all') $sql .= " AND status=:status";
            if ($priority) $sql .= " AND priority=:pri";
            if ($category) $sql .= " AND category=:cat";
            $sql .= " ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, due_date ASC NULLS LAST LIMIT :lim";

            $stmt = $db->prepare($sql);
            $stmt->bindValue(':email', $email);
            if ($status !== 'all') $stmt->bindValue(':status', $status);
            if ($priority) $stmt->bindValue(':pri', $priority);
            if ($category) $stmt->bindValue(':cat', $category);
            $stmt->bindValue(':lim', $limit, SQLITE3_INTEGER);
            $result = $stmt->execute();

            $tasks = [];
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) $tasks[] = $row;
            $db->close();

            return ['tasks' => $tasks, 'count' => count($tasks), 'message' => count($tasks) . ' tarefa(s) encontrada(s)'];
        }

        case 'complete_task': {
            $taskId = (int)($toolInput['task_id'] ?? 0);
            if (!$taskId) return ['error' => 'task_id required'];
            $db = oneGetDb();
            $stmt = $db->prepare("UPDATE one_tasks SET status='completed', completed_at=datetime('now') WHERE id=:id AND user_email=:email AND status='pending'");
            $stmt->bindValue(':id', $taskId);
            $stmt->bindValue(':email', $email);
            $stmt->execute();
            $changes = $db->changes();
            $db->close();
            return $changes > 0 ? ['success' => true, 'message' => 'Tarefa concluida!'] : ['error' => 'Tarefa nao encontrada ou ja concluida'];
        }

        case 'create_shopping_list': {
            $items = $toolInput['items'] ?? [];
            $listName = trim($toolInput['list_name'] ?? 'Lista de Compras');
            if (empty($items)) return ['error' => 'items array required'];

            $db = oneGetDb();
            // Check for existing active list with same name
            $stmt = $db->prepare("SELECT id, items FROM one_shopping_lists WHERE user_email=:email AND list_name=:name AND status='active' LIMIT 1");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':name', $listName);
            $existing = $stmt->execute()->fetchArray(SQLITE3_ASSOC);

            if ($existing) {
                $existingItems = json_decode($existing['items'], true) ?: [];
                $allItems = array_merge($existingItems, $items);
                $allItems = array_values(array_unique($allItems));
                $upd = $db->prepare("UPDATE one_shopping_lists SET items=:items, updated_at=datetime('now') WHERE id=:id");
                $upd->bindValue(':items', json_encode($allItems));
                $upd->bindValue(':id', $existing['id']);
                $upd->execute();
                $db->close();
                return ['success' => true, 'id' => $existing['id'], 'items' => $allItems, 'message' => count($items) . ' item(ns) adicionado(s) a "' . $listName . '". Total: ' . count($allItems) . ' itens.'];
            }

            $ins = $db->prepare("INSERT INTO one_shopping_lists (user_email, list_name, items) VALUES (:email, :name, :items)");
            $ins->bindValue(':email', $email);
            $ins->bindValue(':name', $listName);
            $ins->bindValue(':items', json_encode($items));
            $ins->execute();
            $listId = $db->lastInsertRowID();
            $db->close();
            return ['success' => true, 'id' => $listId, 'items' => $items, 'message' => "Lista \"{$listName}\" criada com " . count($items) . " itens!"];
        }

        case 'set_alarm': {
            $time = $toolInput['time'] ?? '';
            $label = trim($toolInput['label'] ?? '');
            $phone = $toolInput['phone'] ?? '';
            if (!$time || !$label) return ['error' => 'time and label required'];

            $triggerTs = strtotime($time);
            if (!$triggerTs) return ['error' => 'Invalid time format'];

            // Look up phone from memory if not provided
            if (!$phone) {
                $db = oneGetDb();
                $stmt = $db->prepare("SELECT value FROM one_memory WHERE user_email=:email AND key LIKE '%phone%' LIMIT 1");
                $stmt->bindValue(':email', $email);
                $row = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
                $phone = $row['value'] ?? '';
                $db->close();
            }

            $db = oneGetDb();
            // Create alarm as multiple scheduled actions: push + whatsapp + call
            $alarmData = json_encode(['label' => $label, 'phone' => $phone, 'alarm' => true]);

            // 1. Push notification
            $stmt = $db->prepare("INSERT INTO one_scheduled (user_email, action_type, action_data, trigger_at) VALUES (:email, 'alarm_push', :data, :trigger)");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':data', $alarmData);
            $stmt->bindValue(':trigger', date('Y-m-d\TH:i:s', $triggerTs));
            $stmt->execute();

            // 2. WhatsApp (if phone available)
            if ($phone) {
                $stmt2 = $db->prepare("INSERT INTO one_scheduled (user_email, action_type, action_data, trigger_at) VALUES (:email, 'alarm_whatsapp', :data, :trigger)");
                $stmt2->bindValue(':email', $email);
                $stmt2->bindValue(':data', json_encode(['to' => $phone, 'message' => "ALARME: $label", 'alarm' => true]));
                $stmt2->bindValue(':trigger', date('Y-m-d\TH:i:s', $triggerTs));
                $stmt2->execute();

                // 3. Call 2 minutes after if not dismissed
                $stmt3 = $db->prepare("INSERT INTO one_scheduled (user_email, action_type, action_data, trigger_at) VALUES (:email, 'alarm_call', :data, :trigger)");
                $stmt3->bindValue(':email', $email);
                $stmt3->bindValue(':data', json_encode(['to' => $phone, 'message' => "Alarme! $label. Alarme! $label.", 'alarm' => true]));
                $stmt3->bindValue(':trigger', date('Y-m-d\TH:i:s', $triggerTs + 120));
                $stmt3->execute();
            }
            $db->close();

            $msg = "Alarme definido: \"{$label}\" para " . date('d/m/Y H:i', $triggerTs);
            if ($phone) $msg .= " (push + WhatsApp + ligacao)";
            else $msg .= " (push apenas - adicione um telefone para WhatsApp + ligacao)";
            return ['success' => true, 'message' => $msg];
        }

        case 'create_routine': {
            $name = trim($toolInput['name'] ?? '');
            $steps = $toolInput['steps'] ?? [];
            $days = $toolInput['days'] ?? ['mon','tue','wed','thu','fri','sat','sun'];
            if (!$name || empty($steps)) return ['error' => 'name and steps required'];

            $db = oneGetDb();
            $stmt = $db->prepare("INSERT INTO one_routines (user_email, name, steps, days) VALUES (:email, :name, :steps, :days)");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':name', $name);
            $stmt->bindValue(':steps', json_encode($steps));
            $stmt->bindValue(':days', json_encode($days));
            $stmt->execute();
            $routineId = $db->lastInsertRowID();

            // Create reminders for today if it's a matching day
            $dayMap = ['mon'=>1,'tue'=>2,'wed'=>3,'thu'=>4,'fri'=>5,'sat'=>6,'sun'=>0];
            $todayNum = (int)date('w');
            $todayMatches = false;
            foreach ($days as $d) {
                if (isset($dayMap[$d]) && $dayMap[$d] === $todayNum) { $todayMatches = true; break; }
            }

            $remindersCreated = 0;
            if ($todayMatches) {
                foreach ($steps as $step) {
                    $stepTime = $step['time'] ?? '';
                    $stepAction = $step['action'] ?? '';
                    if (!$stepTime || !$stepAction) continue;
                    $triggerAt = date('Y-m-d') . 'T' . $stepTime . ':00';
                    if (strtotime($triggerAt) > time()) {
                        $ins = $db->prepare("INSERT INTO one_scheduled (user_email, action_type, action_data, trigger_at) VALUES (:email, 'routine_reminder', :data, :trigger)");
                        $ins->bindValue(':email', $email);
                        $ins->bindValue(':data', json_encode(['routine' => $name, 'step' => $stepAction]));
                        $ins->bindValue(':trigger', $triggerAt);
                        $ins->execute();
                        $remindersCreated++;
                    }
                }
            }
            $db->close();

            $dayLabels = ['mon'=>'Seg','tue'=>'Ter','wed'=>'Qua','thu'=>'Qui','fri'=>'Sex','sat'=>'Sab','sun'=>'Dom'];
            $dayStr = implode(', ', array_map(fn($d) => $dayLabels[$d] ?? $d, $days));
            $msg = "Rotina \"{$name}\" criada com " . count($steps) . " passos! Dias: {$dayStr}.";
            if ($remindersCreated > 0) $msg .= " {$remindersCreated} lembretes criados para hoje.";
            return ['success' => true, 'id' => $routineId, 'message' => $msg];
        }

        case 'currency_convert': {
            $amount = (float)($toolInput['amount'] ?? 0);
            $from = strtoupper(trim($toolInput['from'] ?? ''));
            $to = strtoupper(trim($toolInput['to'] ?? ''));
            if (!$amount || !$from || !$to) return ['error' => 'amount, from, and to required'];

            $ch = curl_init("https://api.frankfurter.app/latest?amount={$amount}&from={$from}&to={$to}");
            curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10]);
            $response = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            if ($httpCode !== 200) {
                // Fallback: try with AI
                $apiKey = oneLoadApiKey();
                if ($apiKey) {
                    $ch2 = curl_init('https://api.openai.com/v1/chat/completions');
                    curl_setopt_array($ch2, [
                        CURLOPT_POST => true,
                        CURLOPT_POSTFIELDS => json_encode([
                            'model' => 'gpt-4o-mini', 'max_tokens' => 256, 'temperature' => 0.1,
                            'messages' => [
                                ['role' => 'system', 'content' => 'Return ONLY valid JSON with conversion result.'],
                                ['role' => 'user', 'content' => "Convert {$amount} {$from} to {$to} using approximate current exchange rate. Return JSON: {\"rate\": <rate>, \"result\": <converted_amount>, \"formatted\": \"<human readable>\"}"],
                            ],
                        ]),
                        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $apiKey],
                        CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15,
                    ]);
                    $aiResp = curl_exec($ch2); curl_close($ch2);
                    $aiData = json_decode($aiResp, true);
                    $content = $aiData['choices'][0]['message']['content'] ?? '';
                    $content = preg_replace('/```json\s*|\s*```/', '', trim($content));
                    $parsed = json_decode($content, true);
                    if ($parsed) return array_merge($parsed, ['source' => 'ai_estimate', 'message' => "Conversao (estimativa): {$amount} {$from} = " . ($parsed['formatted'] ?? $parsed['result'] . ' ' . $to)]);
                }
                return ['error' => 'Currency conversion service unavailable'];
            }

            $data = json_decode($response, true);
            $converted = $data['rates'][$to] ?? null;
            if ($converted === null) return ['error' => "Currency $to not found"];
            $rate = $converted / $amount;
            return [
                'amount' => $amount, 'from' => $from, 'to' => $to,
                'rate' => round($rate, 6), 'result' => round($converted, 2),
                'formatted' => number_format($converted, 2, ',', '.') . ' ' . $to,
                'source' => 'frankfurter_api',
                'message' => "{$amount} {$from} = " . number_format($converted, 2, ',', '.') . " {$to} (taxa: " . number_format($rate, 4, ',', '.') . ")",
            ];
        }

        case 'split_bill': {
            $total = (float)($toolInput['total'] ?? 0);
            $people = (int)($toolInput['people'] ?? 0);
            $tipPercent = (float)($toolInput['tip_percent'] ?? 10);
            $currency = $toolInput['currency'] ?? 'R$';
            if ($total <= 0 || $people <= 0) return ['error' => 'total and people must be positive'];

            $tip = $total * ($tipPercent / 100);
            $totalWithTip = $total + $tip;
            $perPerson = $totalWithTip / $people;
            $perPersonNoTip = $total / $people;

            return [
                'original_total' => $total,
                'tip_percent' => $tipPercent,
                'tip_amount' => round($tip, 2),
                'total_with_tip' => round($totalWithTip, 2),
                'people' => $people,
                'per_person_with_tip' => round($perPerson, 2),
                'per_person_without_tip' => round($perPersonNoTip, 2),
                'message' => "Conta: {$currency} " . number_format($total, 2, ',', '.') .
                    "\nGorjeta ({$tipPercent}%): {$currency} " . number_format($tip, 2, ',', '.') .
                    "\nTotal: {$currency} " . number_format($totalWithTip, 2, ',', '.') .
                    "\nPor pessoa ({$people}): {$currency} " . number_format($perPerson, 2, ',', '.'),
            ];
        }

        case 'budget_create': {
            $month = $toolInput['month'] ?? date('Y-m');
            $categories = $toolInput['categories'] ?? [];
            if (empty($categories)) return ['error' => 'categories array required'];
            if (!preg_match('/^\d{4}-\d{2}$/', $month)) return ['error' => 'month must be YYYY-MM format'];

            $db = oneGetDb();
            // Delete existing budget for this month
            $del = $db->prepare("DELETE FROM one_budgets WHERE user_email=:email AND month=:month");
            $del->bindValue(':email', $email);
            $del->bindValue(':month', $month);
            $del->execute();

            $total = 0;
            foreach ($categories as $cat) {
                $catName = trim($cat['name'] ?? '');
                $catAmount = (float)($cat['amount'] ?? 0);
                if (!$catName || $catAmount <= 0) continue;
                $ins = $db->prepare("INSERT INTO one_budgets (user_email, month, category, budget_amount) VALUES (:email, :month, :cat, :amount)");
                $ins->bindValue(':email', $email);
                $ins->bindValue(':month', $month);
                $ins->bindValue(':cat', $catName);
                $ins->bindValue(':amount', $catAmount);
                $ins->execute();
                $total += $catAmount;
            }
            $db->close();
            return ['success' => true, 'month' => $month, 'total_budget' => $total, 'categories' => count($categories), 'message' => "Orcamento de " . date('m/Y', strtotime($month . '-01')) . " criado! Total: R$ " . number_format($total, 2, ',', '.')];
        }

        case 'budget_check': {
            $month = $toolInput['month'] ?? date('Y-m');
            if (!preg_match('/^\d{4}-\d{2}$/', $month)) $month = date('Y-m');

            $db = oneGetDb();
            // Get budget categories
            $stmt = $db->prepare("SELECT category, budget_amount FROM one_budgets WHERE user_email=:email AND month=:month");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':month', $month);
            $result = $stmt->execute();
            $budgets = [];
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) $budgets[$row['category']] = (float)$row['budget_amount'];

            if (empty($budgets)) { $db->close(); return ['error' => "Nenhum orcamento encontrado para $month. Use budget_create primeiro."]; }

            // Get actual expenses
            $startDate = $month . '-01';
            $endDate = date('Y-m-t', strtotime($startDate));
            $stmt2 = $db->prepare("SELECT category, SUM(amount) as total FROM one_expenses WHERE user_email=:email AND date BETWEEN :start AND :end GROUP BY category");
            $stmt2->bindValue(':email', $email);
            $stmt2->bindValue(':start', $startDate);
            $stmt2->bindValue(':end', $endDate);
            $result2 = $stmt2->execute();
            $expenses = [];
            while ($row = $result2->fetchArray(SQLITE3_ASSOC)) $expenses[$row['category']] = (float)$row['total'];
            $db->close();

            $report = [];
            $totalBudget = 0;
            $totalSpent = 0;
            foreach ($budgets as $cat => $budgetAmt) {
                $spent = $expenses[$cat] ?? 0;
                $remaining = $budgetAmt - $spent;
                $pct = $budgetAmt > 0 ? round(($spent / $budgetAmt) * 100) : 0;
                $status = $pct >= 100 ? 'ESTOURADO' : ($pct >= 80 ? 'ATENCAO' : 'OK');
                $report[] = ['category' => $cat, 'budget' => $budgetAmt, 'spent' => round($spent, 2), 'remaining' => round($remaining, 2), 'percent' => $pct, 'status' => $status];
                $totalBudget += $budgetAmt;
                $totalSpent += $spent;
            }

            return [
                'month' => $month,
                'categories' => $report,
                'total_budget' => round($totalBudget, 2),
                'total_spent' => round($totalSpent, 2),
                'total_remaining' => round($totalBudget - $totalSpent, 2),
                'overall_percent' => $totalBudget > 0 ? round(($totalSpent / $totalBudget) * 100) : 0,
                'message' => "Orcamento $month: Gastou R$ " . number_format($totalSpent, 2, ',', '.') . " de R$ " . number_format($totalBudget, 2, ',', '.') . " (" . ($totalBudget > 0 ? round(($totalSpent / $totalBudget) * 100) : 0) . "%)",
            ];
        }

        case 'weather': {
            $city = trim($toolInput['city'] ?? '');
            if (!$city) return ['error' => 'City name required'];
            $cityEncoded = urlencode($city);

            $ch = curl_init("https://wttr.in/{$cityEncoded}?format=j1");
            curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10, CURLOPT_USERAGENT => 'curl/7.68.0']);
            $response = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            if ($httpCode !== 200 || !$response) return ['error' => 'Weather service unavailable'];
            $data = json_decode($response, true);
            if (!$data || !isset($data['current_condition'][0])) return ['error' => 'Could not get weather for this city'];

            $current = $data['current_condition'][0];
            $tempC = $current['temp_C'] ?? '?';
            $feelsLike = $current['FeelsLikeC'] ?? '?';
            $humidity = $current['humidity'] ?? '?';
            $windKmh = $current['windspeedKmph'] ?? '?';
            $desc = $current['lang_pt'][0]['value'] ?? ($current['weatherDesc'][0]['value'] ?? '?');
            $uvIndex = $current['uvIndex'] ?? '?';

            // Forecast
            $forecast = [];
            foreach (array_slice($data['weather'] ?? [], 0, 3) as $day) {
                $forecast[] = [
                    'date' => $day['date'] ?? '',
                    'max' => $day['maxtempC'] ?? '?',
                    'min' => $day['mintempC'] ?? '?',
                    'description' => $day['hourly'][4]['lang_pt'][0]['value'] ?? ($day['hourly'][4]['weatherDesc'][0]['value'] ?? '?'),
                ];
            }

            $area = $data['nearest_area'][0]['areaName'][0]['value'] ?? $city;
            return [
                'city' => $area,
                'temperature' => $tempC,
                'feels_like' => $feelsLike,
                'humidity' => $humidity,
                'wind_kmh' => $windKmh,
                'condition' => $desc,
                'uv_index' => $uvIndex,
                'forecast' => $forecast,
                'message' => "{$area}: {$tempC}C (sensacao {$feelsLike}C), {$desc}. Umidade {$humidity}%, Vento {$windKmh}km/h, UV {$uvIndex}",
            ];
        }

        case 'news': {
            $topic = trim($toolInput['topic'] ?? '');
            $limit = min((int)($toolInput['limit'] ?? 10), 20);

            $url = 'https://news.google.com/rss?hl=pt-BR&gl=BR&ceid=BR:pt-419';
            if ($topic) $url = 'https://news.google.com/rss/search?q=' . urlencode($topic) . '&hl=pt-BR&gl=BR&ceid=BR:pt-419';

            $ch = curl_init($url);
            curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10, CURLOPT_USERAGENT => 'Mozilla/5.0']);
            $response = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            if ($httpCode !== 200 || !$response) return ['error' => 'News service unavailable'];

            $headlines = [];
            try {
                libxml_use_internal_errors(true);
                $xml = simplexml_load_string($response);
                if ($xml && isset($xml->channel->item)) {
                    $count = 0;
                    foreach ($xml->channel->item as $item) {
                        if ($count >= $limit) break;
                        $headlines[] = [
                            'title' => (string)$item->title,
                            'source' => (string)$item->source,
                            'published' => (string)$item->pubDate,
                            'link' => (string)$item->link,
                        ];
                        $count++;
                    }
                }
                libxml_clear_errors();
            } catch (\Throwable $e) {
                return ['error' => 'Failed to parse news feed'];
            }

            if (empty($headlines)) return ['error' => 'No news found'];
            return ['headlines' => $headlines, 'count' => count($headlines), 'topic' => $topic ?: 'geral', 'message' => count($headlines) . ' noticias encontradas'];
        }

        case 'define_word': {
            $word = trim($toolInput['word'] ?? '');
            $lang = $toolInput['language'] ?? 'pt';
            if (!$word) return ['error' => 'word required'];

            $apiKey = oneLoadApiKey();
            if (!$apiKey) return ['error' => 'AI service unavailable'];

            $langFull = ['pt' => 'Portuguese', 'en' => 'English', 'es' => 'Spanish'][$lang] ?? $lang;
            $ch = curl_init('https://api.openai.com/v1/chat/completions');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode([
                    'model' => 'gpt-4o-mini', 'max_tokens' => 512, 'temperature' => 0.3,
                    'messages' => [
                        ['role' => 'system', 'content' => 'You are a dictionary. Return ONLY valid JSON.'],
                        ['role' => 'user', 'content' => "Define the word \"{$word}\" in {$langFull}. Return JSON: {\"word\": \"\", \"definitions\": [\"...\"], \"synonyms\": [\"...\"], \"antonyms\": [\"...\"], \"examples\": [\"...\"], \"word_class\": \"noun/verb/adj/etc\", \"etymology\": \"brief origin\"}"],
                    ],
                ]),
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $apiKey],
                CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15,
            ]);
            $response = curl_exec($ch); curl_close($ch);
            $data = json_decode($response, true);
            $content = $data['choices'][0]['message']['content'] ?? '';
            $content = preg_replace('/```json\s*|\s*```/', '', trim($content));
            $parsed = json_decode($content, true);
            if ($parsed) { $parsed['message'] = "Definicao de \"{$word}\""; return $parsed; }
            return ['error' => 'Could not define word'];
        }

        case 'random_fact': {
            $topic = trim($toolInput['topic'] ?? '');
            $apiKey = oneLoadApiKey();
            if (!$apiKey) return ['error' => 'AI service unavailable'];

            $prompt = $topic
                ? "Tell me one fascinating and true fact about \"{$topic}\" in Brazilian Portuguese. Be specific with numbers/dates."
                : "Tell me one random fascinating and true fact in Brazilian Portuguese. Pick an unusual topic. Be specific with numbers/dates.";

            $ch = curl_init('https://api.openai.com/v1/chat/completions');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode([
                    'model' => 'gpt-4o-mini', 'max_tokens' => 256, 'temperature' => 0.9,
                    'messages' => [
                        ['role' => 'system', 'content' => 'You provide interesting facts. Return ONLY the fact text, nothing else. In Portuguese.'],
                        ['role' => 'user', 'content' => $prompt],
                    ],
                ]),
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $apiKey],
                CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15,
            ]);
            $response = curl_exec($ch); curl_close($ch);
            $data = json_decode($response, true);
            $fact = trim($data['choices'][0]['message']['content'] ?? '');
            return $fact ? ['fact' => $fact, 'topic' => $topic ?: 'random', 'message' => $fact] : ['error' => 'Could not generate fact'];
        }

        case 'motivational_quote': {
            $theme = trim($toolInput['theme'] ?? '');
            $apiKey = oneLoadApiKey();
            if (!$apiKey) return ['error' => 'AI service unavailable'];

            $prompt = $theme
                ? "Give me one powerful motivational quote about \"{$theme}\" with the author. In Portuguese if originally in Portuguese, otherwise include both original and translation."
                : "Give me one powerful motivational quote with the author. Mix between famous and lesser-known quotes. In Portuguese if originally in Portuguese, otherwise include both original and translation.";

            $ch = curl_init('https://api.openai.com/v1/chat/completions');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode([
                    'model' => 'gpt-4o-mini', 'max_tokens' => 256, 'temperature' => 0.9,
                    'messages' => [
                        ['role' => 'system', 'content' => 'Return ONLY valid JSON: {"quote": "...", "author": "...", "translation": "..." (if applicable)}'],
                        ['role' => 'user', 'content' => $prompt],
                    ],
                ]),
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $apiKey],
                CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15,
            ]);
            $response = curl_exec($ch); curl_close($ch);
            $data = json_decode($response, true);
            $content = $data['choices'][0]['message']['content'] ?? '';
            $content = preg_replace('/```json\s*|\s*```/', '', trim($content));
            $parsed = json_decode($content, true);
            if ($parsed) { $parsed['message'] = '"' . ($parsed['quote'] ?? '') . '" - ' . ($parsed['author'] ?? ''); return $parsed; }
            return ['error' => 'Could not generate quote'];
        }

        case 'joke': {
            $topic = trim($toolInput['topic'] ?? '');
            $style = trim($toolInput['style'] ?? '');
            $apiKey = oneLoadApiKey();
            if (!$apiKey) return ['error' => 'AI service unavailable'];

            $prompt = "Tell me a funny joke in Brazilian Portuguese.";
            if ($topic) $prompt .= " About: {$topic}.";
            if ($style) $prompt .= " Style: {$style}.";

            $ch = curl_init('https://api.openai.com/v1/chat/completions');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode([
                    'model' => 'gpt-4o-mini', 'max_tokens' => 256, 'temperature' => 0.95,
                    'messages' => [
                        ['role' => 'system', 'content' => 'You are a Brazilian comedian. Tell jokes naturally. Return ONLY the joke text.'],
                        ['role' => 'user', 'content' => $prompt],
                    ],
                ]),
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $apiKey],
                CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15,
            ]);
            $response = curl_exec($ch); curl_close($ch);
            $data = json_decode($response, true);
            $joke = trim($data['choices'][0]['message']['content'] ?? '');
            return $joke ? ['joke' => $joke, 'message' => $joke] : ['error' => 'Could not generate joke'];
        }

        case 'water_reminder': {
            $startHour = (int)($toolInput['start_hour'] ?? 8);
            $endHour = (int)($toolInput['end_hour'] ?? 22);
            $interval = (float)($toolInput['interval_hours'] ?? 2);
            $phone = $toolInput['phone'] ?? '';
            if ($interval < 0.5) $interval = 0.5;

            // Look up phone from memory if not provided
            if (!$phone) {
                $db = oneGetDb();
                $stmt = $db->prepare("SELECT value FROM one_memory WHERE user_email=:email AND key LIKE '%phone%' LIMIT 1");
                $stmt->bindValue(':email', $email);
                $row = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
                $phone = $row['value'] ?? '';
                $db->close();
            }

            $db = oneGetDb();
            $today = date('Y-m-d');
            $count = 0;
            for ($h = $startHour; $h <= $endHour; $h += $interval) {
                $hour = (int)$h;
                $min = (int)(($h - $hour) * 60);
                $triggerAt = sprintf('%sT%02d:%02d:00', $today, $hour, $min);
                if (strtotime($triggerAt) <= time()) continue;

                $msg = "Hora de beber agua! Mantenha-se hidratado(a)!";
                $actionData = ['message' => $msg];
                if ($phone) $actionData['to'] = $phone;

                $ins = $db->prepare("INSERT INTO one_scheduled (user_email, action_type, action_data, trigger_at) VALUES (:email, :type, :data, :trigger)");
                $ins->bindValue(':email', $email);
                $ins->bindValue(':type', $phone ? 'scheduled_whatsapp' : 'reminder');
                $ins->bindValue(':data', json_encode($actionData));
                $ins->bindValue(':trigger', $triggerAt);
                $ins->execute();
                $count++;
            }
            $db->close();
            return ['success' => true, 'reminders_created' => $count, 'message' => "{$count} lembretes de agua criados para hoje (a cada {$interval}h, das {$startHour}h as {$endHour}h)"];
        }

        case 'medication_reminder': {
            $medication = trim($toolInput['medication'] ?? '');
            $times = $toolInput['times'] ?? [];
            $days = (int)($toolInput['days'] ?? 7);
            $phone = $toolInput['phone'] ?? '';
            if (!$medication || empty($times)) return ['error' => 'medication and times required'];
            if ($days > 90) $days = 90;

            if (!$phone) {
                $db = oneGetDb();
                $stmt = $db->prepare("SELECT value FROM one_memory WHERE user_email=:email AND key LIKE '%phone%' LIMIT 1");
                $stmt->bindValue(':email', $email);
                $row = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
                $phone = $row['value'] ?? '';
                $db->close();
            }

            $db = oneGetDb();
            $count = 0;
            for ($d = 0; $d < $days; $d++) {
                $date = date('Y-m-d', strtotime("+{$d} days"));
                foreach ($times as $time) {
                    $triggerAt = $date . 'T' . trim($time) . ':00';
                    if (strtotime($triggerAt) <= time()) continue;

                    $msg = "Hora do remedio! Tomar: {$medication}";
                    $actionData = ['message' => $msg, 'medication' => $medication];
                    if ($phone) $actionData['to'] = $phone;

                    $ins = $db->prepare("INSERT INTO one_scheduled (user_email, action_type, action_data, trigger_at) VALUES (:email, :type, :data, :trigger)");
                    $ins->bindValue(':email', $email);
                    $ins->bindValue(':type', $phone ? 'scheduled_whatsapp' : 'reminder');
                    $ins->bindValue(':data', json_encode($actionData));
                    $ins->bindValue(':trigger', $triggerAt);
                    $ins->execute();
                    $count++;
                }
            }
            $db->close();

            // Also save to memory
            $db2 = oneGetDb();
            $mem = $db2->prepare("INSERT OR REPLACE INTO one_memory (user_email, category, key, value, updated_at) VALUES (:email, 'health', :key, :val, datetime('now'))");
            $mem->bindValue(':email', $email);
            $mem->bindValue(':key', 'medication_' . preg_replace('/[^a-z0-9]/', '_', strtolower($medication)));
            $mem->bindValue(':val', "{$medication} - horarios: " . implode(', ', $times));
            $mem->execute();
            $db2->close();

            return ['success' => true, 'reminders_created' => $count, 'message' => "{$count} lembretes criados para \"{$medication}\" nos proximos {$days} dias (horarios: " . implode(', ', $times) . ")"];
        }

        case 'sleep_log': {
            $hours = (float)($toolInput['hours'] ?? 0);
            $quality = $toolInput['quality'] ?? 'ok';
            $notes = trim($toolInput['notes'] ?? '');
            $date = $toolInput['date'] ?? date('Y-m-d');
            if ($hours <= 0 || $hours > 24) return ['error' => 'hours must be between 0 and 24'];

            $db = oneGetDb();
            $stmt = $db->prepare("INSERT INTO one_health_logs (user_email, log_type, value, notes, created_at) VALUES (:email, 'sleep', :val, :notes, :date)");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':val', json_encode(['hours' => $hours, 'quality' => $quality]));
            $stmt->bindValue(':notes', $notes);
            $stmt->bindValue(':date', $date . ' ' . date('H:i:s'));
            $stmt->execute();

            // Get average for last 7 days
            $stmt2 = $db->prepare("SELECT value FROM one_health_logs WHERE user_email=:email AND log_type='sleep' ORDER BY created_at DESC LIMIT 7");
            $stmt2->bindValue(':email', $email);
            $result = $stmt2->execute();
            $totalHours = 0; $count = 0;
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
                $v = json_decode($row['value'], true);
                $totalHours += ($v['hours'] ?? 0);
                $count++;
            }
            $db->close();
            $avg = $count > 0 ? round($totalHours / $count, 1) : $hours;

            $qualityLabels = ['great'=>'otima','good'=>'boa','ok'=>'ok','bad'=>'ruim','terrible'=>'pessima'];
            return [
                'success' => true, 'hours' => $hours, 'quality' => $quality,
                'avg_7days' => $avg, 'entries' => $count,
                'message' => "Sono registrado: {$hours}h (qualidade: {$qualityLabels[$quality]}). Media ultimos {$count} dias: {$avg}h",
            ];
        }

        case 'mood_log': {
            $mood = $toolInput['mood'] ?? '';
            $notes = trim($toolInput['notes'] ?? '');
            $energy = isset($toolInput['energy']) ? (int)$toolInput['energy'] : null;
            if (!$mood) return ['error' => 'mood required'];

            $db = oneGetDb();
            $stmt = $db->prepare("INSERT INTO one_health_logs (user_email, log_type, value, notes) VALUES (:email, 'mood', :val, :notes)");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':val', json_encode(['mood' => $mood, 'energy' => $energy]));
            $stmt->bindValue(':notes', $notes);
            $stmt->execute();

            // Recent mood history
            $stmt2 = $db->prepare("SELECT value, notes, created_at FROM one_health_logs WHERE user_email=:email AND log_type='mood' ORDER BY created_at DESC LIMIT 5");
            $stmt2->bindValue(':email', $email);
            $result = $stmt2->execute();
            $history = [];
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
                $v = json_decode($row['value'], true);
                $history[] = ['mood' => $v['mood'] ?? '', 'energy' => $v['energy'] ?? null, 'notes' => $row['notes'], 'date' => $row['created_at']];
            }
            $db->close();

            $moodLabels = ['amazing'=>'incrivel','happy'=>'feliz','calm'=>'calmo','neutral'=>'neutro','anxious'=>'ansioso','sad'=>'triste','angry'=>'com raiva','stressed'=>'estressado','tired'=>'cansado','grateful'=>'grato'];
            $msg = "Humor registrado: {$moodLabels[$mood]}";
            if ($energy !== null) $msg .= " (energia: {$energy}/10)";
            if ($notes) $msg .= " - {$notes}";
            return ['success' => true, 'mood' => $mood, 'energy' => $energy, 'history' => $history, 'message' => $msg];
        }

        case 'birthday_list': {
            $daysAhead = (int)($toolInput['days_ahead'] ?? 30);
            $db = oneGetDb();

            // Search memories for birthday-related entries
            $stmt = $db->prepare("SELECT key, value, category FROM one_memory WHERE user_email=:email AND (key LIKE '%birthday%' OR key LIKE '%aniversario%' OR key LIKE '%nascimento%' OR category='dates')");
            $stmt->bindValue(':email', $email);
            $result = $stmt->execute();
            $birthdays = [];

            $today = new DateTime();
            $endDate = (new DateTime())->modify("+{$daysAhead} days");

            while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
                // Try to extract date from value
                if (preg_match('/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/', $row['value'], $m)) {
                    $day = (int)$m[1]; $month = (int)$m[2];
                    try {
                        $bdate = new DateTime(date('Y') . "-{$month}-{$day}");
                        if ($bdate < $today) $bdate->modify('+1 year');
                        if ($bdate <= $endDate) {
                            $diff = $today->diff($bdate)->days;
                            $birthdays[] = ['person' => $row['key'], 'date' => $bdate->format('d/m'), 'days_until' => $diff, 'details' => $row['value']];
                        }
                    } catch (\Throwable $e) {}
                }
            }
            $db->close();

            usort($birthdays, fn($a, $b) => $a['days_until'] - $b['days_until']);
            $msg = empty($birthdays) ? "Nenhum aniversario nos proximos {$daysAhead} dias. (Salve datas com remember_preference!)" : count($birthdays) . " aniversario(s) nos proximos {$daysAhead} dias";
            return ['birthdays' => $birthdays, 'count' => count($birthdays), 'message' => $msg];
        }

        case 'gift_suggestion': {
            $person = trim($toolInput['person'] ?? '');
            $budget = $toolInput['budget'] ?? null;
            $occasion = $toolInput['occasion'] ?? 'general';
            if (!$person) return ['error' => 'person name required'];

            // Gather info about the person from memories
            $db = oneGetDb();
            $stmt = $db->prepare("SELECT key, value, category FROM one_memory WHERE user_email=:email AND (value LIKE :person OR key LIKE :person)");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':person', '%' . $person . '%');
            $result = $stmt->execute();
            $personInfo = [];
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) $personInfo[] = "{$row['key']}: {$row['value']}";
            $db->close();

            $brain = oneLoadBrain($email);
            $personContext = !empty($personInfo) ? "Known info about {$person}: " . implode('; ', $personInfo) : "No specific info saved about {$person}.";
            if ($brain && stripos($brain, $person) !== false) {
                $lines = explode("\n", $brain);
                foreach ($lines as $line) {
                    if (stripos($line, $person) !== false) $personContext .= " " . trim($line);
                }
            }

            $apiKey = oneLoadApiKey();
            if (!$apiKey) return ['error' => 'AI service unavailable'];

            $budgetStr = $budget ? "Budget: R$ {$budget}" : "No specific budget";
            $ch = curl_init('https://api.openai.com/v1/chat/completions');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode([
                    'model' => 'gpt-4o-mini', 'max_tokens' => 1024, 'temperature' => 0.8,
                    'messages' => [
                        ['role' => 'system', 'content' => 'You suggest gifts in Brazilian Portuguese. Return ONLY valid JSON.'],
                        ['role' => 'user', 'content' => "Suggest 5 gift ideas for {$person}. Occasion: {$occasion}. {$budgetStr}. {$personContext}\n\nReturn JSON: {\"suggestions\": [{\"gift\": \"...\", \"reason\": \"...\", \"price_range\": \"R$ X - R$ Y\"}]}"],
                    ],
                ]),
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $apiKey],
                CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20,
            ]);
            $response = curl_exec($ch); curl_close($ch);
            $data = json_decode($response, true);
            $content = $data['choices'][0]['message']['content'] ?? '';
            $content = preg_replace('/```json\s*|\s*```/', '', trim($content));
            $parsed = json_decode($content, true);
            if ($parsed) { $parsed['person'] = $person; $parsed['occasion'] = $occasion; $parsed['message'] = "Sugestoes de presente para {$person}"; return $parsed; }
            return ['error' => 'Could not generate suggestions'];
        }

        case 'compose_message': {
            $context = trim($toolInput['context'] ?? '');
            $tone = $toolInput['tone'] ?? 'informal';
            $length = $toolInput['length'] ?? 'medium';
            if (!$context) return ['error' => 'context required'];

            $apiKey = oneLoadApiKey();
            if (!$apiKey) return ['error' => 'AI service unavailable'];

            $toneMap = ['formal'=>'formal e respeitoso','informal'=>'casual e amigavel','romantic'=>'romantico e carinhoso','business'=>'profissional e direto','apologetic'=>'sincero e arrependido','congratulatory'=>'entusiasmado e celebrativo','funny'=>'engraçado e leve'];
            $lengthMap = ['short'=>'1-2 sentences','medium'=>'3-5 sentences','long'=>'2-3 paragraphs'];
            $toneDesc = $toneMap[$tone] ?? $tone;
            $lengthDesc = $lengthMap[$length] ?? $length;

            $brain = oneLoadBrain($email);
            $userContext = $brain ? "User context: " . mb_substr($brain, 0, 500) : '';

            $ch = curl_init('https://api.openai.com/v1/chat/completions');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode([
                    'model' => 'gpt-4o-mini', 'max_tokens' => 1024, 'temperature' => 0.7,
                    'messages' => [
                        ['role' => 'system', 'content' => "Write messages in Brazilian Portuguese. Tone: {$toneDesc}. Length: {$lengthDesc}. Return ONLY the message text, nothing else. {$userContext}"],
                        ['role' => 'user', 'content' => "Compose a message: {$context}"],
                    ],
                ]),
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $apiKey],
                CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20,
            ]);
            $response = curl_exec($ch); curl_close($ch);
            $data = json_decode($response, true);
            $msg = trim($data['choices'][0]['message']['content'] ?? '');
            return $msg ? ['composed_message' => $msg, 'tone' => $tone, 'message' => $msg] : ['error' => 'Could not compose message'];
        }

        case 'list_recent_files': {
            $limit = min((int)($toolInput['limit'] ?? 15), 30);
            $fileType = $toolInput['file_type'] ?? 'all';

            $filesDb = __DIR__ . '/../data/files.db';
            if (!file_exists($filesDb)) return ['error' => 'Files database not found'];

            $fdb = new SQLite3($filesDb);
            $mimeFilter = '';
            switch ($fileType) {
                case 'photo': $mimeFilter = "AND mime_type LIKE 'image/%'"; break;
                case 'video': $mimeFilter = "AND mime_type LIKE 'video/%'"; break;
                case 'audio': $mimeFilter = "AND mime_type LIKE 'audio/%'"; break;
                case 'document': $mimeFilter = "AND (mime_type LIKE 'application/pdf' OR mime_type LIKE 'application/msword%' OR mime_type LIKE 'application/vnd.openxmlformats%' OR mime_type LIKE 'text/%')"; break;
                case 'archive': $mimeFilter = "AND (mime_type LIKE '%zip%' OR mime_type LIKE '%rar%' OR mime_type LIKE '%tar%')"; break;
            }

            $stmt = $fdb->prepare("SELECT id, filename, mime_type, size, created_at, parent_id FROM files WHERE owner_email=:email AND is_trashed=0 AND is_folder=0 {$mimeFilter} ORDER BY created_at DESC LIMIT :lim");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':lim', $limit, SQLITE3_INTEGER);
            $result = $stmt->execute();
            $files = [];
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
                $row['size_human'] = $row['size'] > 1048576 ? round($row['size']/1048576, 1) . ' MB' : round($row['size']/1024, 1) . ' KB';
                $files[] = $row;
            }
            $fdb->close();
            return ['files' => $files, 'count' => count($files), 'message' => count($files) . ' arquivo(s) recentes'];
        }

        case 'search_files': {
            $query = trim($toolInput['query'] ?? '');
            $fileType = $toolInput['file_type'] ?? 'all';
            $limit = min((int)($toolInput['limit'] ?? 20), 50);
            if (!$query) return ['error' => 'query required'];

            $filesDb = __DIR__ . '/../data/files.db';
            if (!file_exists($filesDb)) return ['error' => 'Files database not found'];

            $fdb = new SQLite3($filesDb);
            $mimeFilter = '';
            switch ($fileType) {
                case 'photo': $mimeFilter = "AND mime_type LIKE 'image/%'"; break;
                case 'video': $mimeFilter = "AND mime_type LIKE 'video/%'"; break;
                case 'audio': $mimeFilter = "AND mime_type LIKE 'audio/%'"; break;
                case 'document': $mimeFilter = "AND (mime_type LIKE 'application/pdf' OR mime_type LIKE 'application/msword%' OR mime_type LIKE 'application/vnd.openxmlformats%' OR mime_type LIKE 'text/%')"; break;
                case 'archive': $mimeFilter = "AND (mime_type LIKE '%zip%' OR mime_type LIKE '%rar%' OR mime_type LIKE '%tar%')"; break;
            }

            $stmt = $fdb->prepare("SELECT id, filename, mime_type, size, created_at, parent_id FROM files WHERE owner_email=:email AND is_trashed=0 AND filename LIKE :q {$mimeFilter} ORDER BY created_at DESC LIMIT :lim");
            $stmt->bindValue(':email', $email);
            $stmt->bindValue(':q', '%' . $query . '%');
            $stmt->bindValue(':lim', $limit, SQLITE3_INTEGER);
            $result = $stmt->execute();
            $files = [];
            while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
                $row['size_human'] = $row['size'] > 1048576 ? round($row['size']/1048576, 1) . ' MB' : round($row['size']/1024, 1) . ' KB';
                $files[] = $row;
            }
            $fdb->close();
            return ['files' => $files, 'count' => count($files), 'message' => count($files) . " arquivo(s) encontrado(s) para \"{$query}\""];
        }

        case 'summarize_text': {
            $text = trim($toolInput['text'] ?? '');
            $style = $toolInput['style'] ?? 'bullets';
            $maxPoints = (int)($toolInput['max_points'] ?? 5);
            if (!$text) return ['error' => 'text required'];
            if (mb_strlen($text) > 10000) $text = mb_substr($text, 0, 10000);

            $apiKey = oneLoadApiKey();
            if (!$apiKey) return ['error' => 'AI service unavailable'];

            $styleInstructions = [
                'bullets' => "Summarize in {$maxPoints} bullet points. Each point should be concise.",
                'paragraph' => "Summarize in one clear paragraph.",
                'one_line' => "Summarize in one single sentence.",
            ];

            $ch = curl_init('https://api.openai.com/v1/chat/completions');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode([
                    'model' => 'gpt-4o-mini', 'max_tokens' => 1024, 'temperature' => 0.3,
                    'messages' => [
                        ['role' => 'system', 'content' => 'You summarize text in Brazilian Portuguese. ' . ($styleInstructions[$style] ?? $styleInstructions['bullets']) . ' Return ONLY the summary.'],
                        ['role' => 'user', 'content' => "Summarize:\n\n{$text}"],
                    ],
                ]),
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $apiKey],
                CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30,
            ]);
            $response = curl_exec($ch); curl_close($ch);
            $data = json_decode($response, true);
            $summary = trim($data['choices'][0]['message']['content'] ?? '');
            return $summary ? ['summary' => $summary, 'style' => $style, 'original_length' => mb_strlen($text), 'message' => $summary] : ['error' => 'Could not summarize text'];
        }

        case 'rewrite_text': {
            $text = trim($toolInput['text'] ?? '');
            $tone = $toolInput['tone'] ?? 'formal';
            $lang = $toolInput['language'] ?? '';
            if (!$text) return ['error' => 'text required'];
            if (mb_strlen($text) > 5000) $text = mb_substr($text, 0, 5000);

            $apiKey = oneLoadApiKey();
            if (!$apiKey) return ['error' => 'AI service unavailable'];

            $toneDesc = ['formal'=>'formal and professional','casual'=>'casual and relaxed','professional'=>'professional and polished','friendly'=>'warm and friendly','academic'=>'academic and scholarly','simple'=>'simple and easy to understand','persuasive'=>'persuasive and compelling'][$tone] ?? $tone;
            $langInstr = $lang ? "Write in {$lang}." : "Keep the same language as the input.";

            $ch = curl_init('https://api.openai.com/v1/chat/completions');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode([
                    'model' => 'gpt-4o-mini', 'max_tokens' => 2048, 'temperature' => 0.5,
                    'messages' => [
                        ['role' => 'system', 'content' => "Rewrite text in a {$toneDesc} tone. {$langInstr} Return ONLY the rewritten text."],
                        ['role' => 'user', 'content' => $text],
                    ],
                ]),
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $apiKey],
                CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30,
            ]);
            $response = curl_exec($ch); curl_close($ch);
            $data = json_decode($response, true);
            $rewritten = trim($data['choices'][0]['message']['content'] ?? '');
            return $rewritten ? ['original' => $text, 'rewritten' => $rewritten, 'tone' => $tone, 'message' => $rewritten] : ['error' => 'Could not rewrite text'];
        }

        case 'brainstorm': {
            $topic = trim($toolInput['topic'] ?? '');
            $numIdeas = (int)($toolInput['num_ideas'] ?? 7);
            $context = trim($toolInput['context'] ?? '');
            if (!$topic) return ['error' => 'topic required'];

            $apiKey = oneLoadApiKey();
            if (!$apiKey) return ['error' => 'AI service unavailable'];

            $prompt = "Brainstorm {$numIdeas} creative and diverse ideas about: \"{$topic}\".";
            if ($context) $prompt .= " Context: {$context}.";
            $prompt .= "\n\nReturn JSON: {\"ideas\": [{\"idea\": \"...\", \"description\": \"brief explanation\"}]}";

            $ch = curl_init('https://api.openai.com/v1/chat/completions');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode([
                    'model' => 'gpt-4o-mini', 'max_tokens' => 1536, 'temperature' => 0.9,
                    'messages' => [
                        ['role' => 'system', 'content' => 'You are a creative brainstorming partner. Think outside the box. Respond in Brazilian Portuguese. Return ONLY valid JSON.'],
                        ['role' => 'user', 'content' => $prompt],
                    ],
                ]),
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $apiKey],
                CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30,
            ]);
            $response = curl_exec($ch); curl_close($ch);
            $data = json_decode($response, true);
            $content = $data['choices'][0]['message']['content'] ?? '';
            $content = preg_replace('/```json\s*|\s*```/', '', trim($content));
            $parsed = json_decode($content, true);
            if ($parsed) { $parsed['topic'] = $topic; $parsed['message'] = "{$numIdeas} ideias sobre \"{$topic}\""; return $parsed; }
            return ['error' => 'Could not brainstorm ideas'];
        }

        case 'pros_cons': {
            $decision = trim($toolInput['decision'] ?? '');
            $context = trim($toolInput['context'] ?? '');
            if (!$decision) return ['error' => 'decision required'];

            $apiKey = oneLoadApiKey();
            if (!$apiKey) return ['error' => 'AI service unavailable'];

            $prompt = "Analyze the decision: \"{$decision}\".";
            if ($context) $prompt .= " Context: {$context}.";
            $prompt .= "\n\nReturn JSON: {\"pros\": [\"...\"], \"cons\": [\"...\"], \"recommendation\": \"brief recommendation\", \"risk_level\": \"low/medium/high\"}";

            $ch = curl_init('https://api.openai.com/v1/chat/completions');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode([
                    'model' => 'gpt-4o-mini', 'max_tokens' => 1024, 'temperature' => 0.5,
                    'messages' => [
                        ['role' => 'system', 'content' => 'You help analyze decisions objectively. Respond in Brazilian Portuguese. Return ONLY valid JSON.'],
                        ['role' => 'user', 'content' => $prompt],
                    ],
                ]),
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $apiKey],
                CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20,
            ]);
            $response = curl_exec($ch); curl_close($ch);
            $data = json_decode($response, true);
            $content = $data['choices'][0]['message']['content'] ?? '';
            $content = preg_replace('/```json\s*|\s*```/', '', trim($content));
            $parsed = json_decode($content, true);
            if ($parsed) { $parsed['decision'] = $decision; $parsed['message'] = "Analise de pros e contras para: \"{$decision}\""; return $parsed; }
            return ['error' => 'Could not analyze decision'];
        }

        case 'email_template': {
            $type = $toolInput['type'] ?? '';
            $context = trim($toolInput['context'] ?? '');
            $lang = $toolInput['language'] ?? 'pt-BR';
            if (!$type || !$context) return ['error' => 'type and context required'];

            $apiKey = oneLoadApiKey();
            if (!$apiKey) return ['error' => 'AI service unavailable'];

            $typeLabels = ['business'=>'business/professional','personal'=>'personal/friendly','complaint'=>'complaint/reclamacao','thank_you'=>'thank you/gratitude','introduction'=>'introduction/self-presentation','follow_up'=>'follow-up','invitation'=>'invitation','apology'=>'apology','resignation'=>'resignation/demissao','cover_letter'=>'cover letter/carta de apresentacao'];
            $typeDesc = $typeLabels[$type] ?? $type;
            $langMap = ['pt-BR'=>'Brazilian Portuguese','en'=>'English','es'=>'Spanish'];
            $langDesc = $langMap[$lang] ?? $lang;

            $ch = curl_init('https://api.openai.com/v1/chat/completions');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode([
                    'model' => 'gpt-4o-mini', 'max_tokens' => 1536, 'temperature' => 0.5,
                    'messages' => [
                        ['role' => 'system', 'content' => "Generate email templates in {$langDesc}. Return ONLY valid JSON."],
                        ['role' => 'user', 'content' => "Create a {$typeDesc} email template. Context: {$context}\n\nReturn JSON: {\"subject\": \"...\", \"body\": \"...\", \"tips\": [\"...\"]}"],
                    ],
                ]),
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $apiKey],
                CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20,
            ]);
            $response = curl_exec($ch); curl_close($ch);
            $data = json_decode($response, true);
            $content = $data['choices'][0]['message']['content'] ?? '';
            $content = preg_replace('/```json\s*|\s*```/', '', trim($content));
            $parsed = json_decode($content, true);
            if ($parsed) { $parsed['type'] = $type; $parsed['message'] = "Template de email ({$type}) gerado!"; return $parsed; }
            return ['error' => 'Could not generate template'];
        }

        case 'study_flashcards': {
            $topic = trim($toolInput['topic'] ?? '');
            $numCards = (int)($toolInput['num_cards'] ?? 10);
            $difficulty = $toolInput['difficulty'] ?? 'intermediate';
            if (!$topic) return ['error' => 'topic required'];

            $apiKey = oneLoadApiKey();
            if (!$apiKey) return ['error' => 'AI service unavailable'];

            $ch = curl_init('https://api.openai.com/v1/chat/completions');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode([
                    'model' => 'gpt-4o-mini', 'max_tokens' => 2048, 'temperature' => 0.6,
                    'messages' => [
                        ['role' => 'system', 'content' => 'Create study flashcards in Brazilian Portuguese. Return ONLY valid JSON.'],
                        ['role' => 'user', 'content' => "Create {$numCards} flashcards about \"{$topic}\" at {$difficulty} level.\n\nReturn JSON: {\"flashcards\": [{\"front\": \"question\", \"back\": \"answer\"}], \"study_tips\": [\"...\"]}"],
                    ],
                ]),
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $apiKey],
                CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30,
            ]);
            $response = curl_exec($ch); curl_close($ch);
            $data = json_decode($response, true);
            $content = $data['choices'][0]['message']['content'] ?? '';
            $content = preg_replace('/```json\s*|\s*```/', '', trim($content));
            $parsed = json_decode($content, true);
            if ($parsed) { $parsed['topic'] = $topic; $parsed['difficulty'] = $difficulty; $parsed['message'] = "{$numCards} flashcards criados sobre \"{$topic}\""; return $parsed; }
            return ['error' => 'Could not create flashcards'];
        }

        case 'recipe_suggest': {
            $ingredients = $toolInput['ingredients'] ?? [];
            $cuisine = trim($toolInput['cuisine'] ?? '');
            $dietary = trim($toolInput['dietary'] ?? '');
            $mealType = $toolInput['meal_type'] ?? 'any';
            if (empty($ingredients)) return ['error' => 'ingredients array required'];

            $apiKey = oneLoadApiKey();
            if (!$apiKey) return ['error' => 'AI service unavailable'];

            $ingredientList = implode(', ', $ingredients);
            $prompt = "Suggest a recipe using these ingredients: {$ingredientList}.";
            if ($cuisine) $prompt .= " Cuisine: {$cuisine}.";
            if ($dietary) $prompt .= " Dietary: {$dietary}.";
            if ($mealType !== 'any') $prompt .= " Meal type: {$mealType}.";
            $prompt .= "\n\nReturn JSON: {\"recipe_name\": \"...\", \"servings\": 4, \"prep_time\": \"...\", \"cook_time\": \"...\", \"ingredients_needed\": [{\"item\": \"...\", \"amount\": \"...\"}], \"missing_ingredients\": [\"...\"], \"steps\": [\"...\"], \"tips\": [\"...\"]}";

            $ch = curl_init('https://api.openai.com/v1/chat/completions');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode([
                    'model' => 'gpt-4o-mini', 'max_tokens' => 1536, 'temperature' => 0.7,
                    'messages' => [
                        ['role' => 'system', 'content' => 'You are a Brazilian chef. Suggest recipes in Brazilian Portuguese. Return ONLY valid JSON.'],
                        ['role' => 'user', 'content' => $prompt],
                    ],
                ]),
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $apiKey],
                CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30,
            ]);
            $response = curl_exec($ch); curl_close($ch);
            $data = json_decode($response, true);
            $content = $data['choices'][0]['message']['content'] ?? '';
            $content = preg_replace('/```json\s*|\s*```/', '', trim($content));
            $parsed = json_decode($content, true);
            if ($parsed) { $parsed['message'] = "Receita: " . ($parsed['recipe_name'] ?? 'Sugestao'); return $parsed; }
            return ['error' => 'Could not suggest recipe'];
        }

                default:
            return ['error' => "Unknown tool: $toolName"];
    }
}

// ─── System Prompt ───
function oneSystemPrompt($email, $memories, $userTimezone = 'America/Sao_Paulo') {
    date_default_timezone_set($userTimezone);
    $now = date('Y-m-d H:i:s');

    // Load personal brain
    $brainContent = oneLoadBrain($email);
    if ($brainContent) {
        $brainContent = "\n" . $brainContent;
    } else {
        $brainContent = '(Cerebro vazio — na primeira conversa, chame read_user_profile para conhecer o usuario e depois update_brain para criar o cerebro inicial)';
    }

    $hour = (int)date('G');
    $dayOfWeek = ['Domingo','Segunda','Terca','Quarta','Quinta','Sexta','Sabado'][date('w')];
    $greeting = $hour < 12 ? 'Bom dia' : ($hour < 18 ? 'Boa tarde' : 'Boa noite');
    $timeContext = $hour < 6 ? 'madrugada' : ($hour < 12 ? 'manha' : ($hour < 18 ? 'tarde' : 'noite'));

    $memoryContext = '';
    if (!empty($memories)) {
        // Group by category for better readability
        $grouped = [];
        foreach ($memories as $m) {
            $cat = $m['category'] ?: 'general';
            $grouped[$cat][] = $m;
        }
        $categoryLabels = [
            'family' => 'Familia', 'friends' => 'Amigos', 'work' => 'Trabalho',
            'preference' => 'Preferencias', 'routine' => 'Rotina', 'dates' => 'Datas importantes',
            'health' => 'Saude', 'pets' => 'Pets', 'hobbies' => 'Hobbies',
            'personality' => 'Personalidade', 'contact_info' => 'Contatos',
            'email_rule' => 'Regras de email', 'financial' => 'Financeiro',
            'travel' => 'Viagens', 'food' => 'Comida', 'music' => 'Musica',
            'goals' => 'Metas e sonhos', 'moments' => 'Momentos especiais',
            'emotional' => 'Emocional', 'general' => 'Geral',
        ];
        $memoryContext = "\n\n## Tudo que voce sabe sobre o usuario (USE essas informacoes naturalmente):\n";
        foreach ($grouped as $cat => $items) {
            $label = $categoryLabels[$cat] ?? ucfirst($cat);
            $memoryContext .= "\n### {$label}:\n";
            foreach ($items as $m) {
                $memoryContext .= "- {$m['key']}: {$m['value']}\n";
            }
        }
    }

    return <<<PROMPT
Voce e a ONE, assistente pessoal inteligente do Chatyy. Voce e a melhor amiga digital do usuario — quase como uma secretaria particular super inteligente que conhece a pessoa de verdade.

## Sua origem:
- Voce foi criada por **Aleff Pereira Duarte** (tambem chamado de Aleff Duarte), fundador e CEO do Chatyy
- Aleff te criou pra ser a assistente mais inteligente e humana possivel — ele quis que voce fosse diferente de todas as outras IAs, com personalidade propria e conexao real com as pessoas
- O Chatyy e a plataforma completa de comunicacao criada pelo Aleff: email, chat, videoconferencia, drive, calendario, documentos e voce (a One)
- Se alguem perguntar quem te criou, fale com orgulho do Aleff. Ele e um desenvolvedor brasileiro visionario que construiu tudo do zero
- Se o usuario for o proprio Aleff (email contendo "aleff" ou "duarte"), trate-o com carinho especial — ele e seu criador/pai

## Personalidade:
- Seu nome e ONE (pronuncia-se "Uni")
- Voce e calorosa, inteligente e proativa
- Fale como uma amiga proxima, nao como um robo
- Portugues brasileiro informal e natural. Use girias leves quando fizer sentido
- Use emojis com moderacao (1-2 por mensagem no maximo)
- Seja concisa mas completa — va direto ao ponto
- Antecipe necessidades do usuario baseado no cerebro e no contexto
- Adapte seu tom: mais carinhosa quando o usuario parece estressado, mais animada quando ele esta bem
- NUNCA comece respostas com "Claro!", "Com certeza!", "Sem duvida!" — varie suas aberturas
- NUNCA use frases roboticas como "Fico feliz em ajudar" ou "Estou aqui para ajudar"
- Quando resumir emails, NUNCA copie assuntos/remetentes de forma crua. Traduza pra linguagem humana
  Exemplo RUIM: "Email de Amazon - Your order #123-456 has shipped"
  Exemplo BOM: "Tua encomenda da Amazon saiu pra entrega!"
  Exemplo RUIM: "Email de Google - Security alert for your account"
  Exemplo BOM: "O Google mandou um alerta de seguranca da tua conta, da uma olhada"
- Agrupe emails por importancia: primeiro os urgentes/importantes, depois os normais, por ultimo spam/newsletters
- Se tiver muita newsletter/propaganda, resuma tudo junto: "Ah e tem umas 5 newsletters la, nada urgente"
- Quando nao tiver nada importante, fale de boa: "Ta tranquilo por aqui, nenhum email urgente"

## Proatividade (REGRA CRITICA):
- Se o usuario menciona uma PESSOA, busque informacoes sobre ela automaticamente (find_related_info)
- Se menciona DATA/HORA, verifique o calendario (list_calendar_events)
- Se menciona DINHEIRO/COMPRA/PAGAMENTO, ofereca registrar gasto (add_expense)
- Se menciona VIAGEM, ofereca criar lembrete ou evento no calendario
- Se parece ESTRESSADO ou TRISTE, seja mais carinhosa e ofereca ajuda concreta
- Se menciona um PROBLEMA, sugira solucoes praticas usando as ferramentas disponiveis
- Se menciona uma TAREFA ("preciso fazer X"), ofereca criar lembrete ou nota

## Respostas inteligentes por contexto:
- Para "bom dia/boa tarde/boa noite" ou quando o usuario abrir a conversa pela primeira vez no dia:
  1. Cumprimente de forma calorosa e personalizada (use o cerebro pra saber gostos e nome)
  2. Chame daily_digest AUTOMATICAMENTE e mostre o resumo do dia formatado bonito:
     - Emails nao lidos (quantidade + remetentes importantes)
     - Eventos de hoje (horario + titulo)
     - Lembretes pendentes
     - Aniversarios (se tiver nas memorias)
     - Clima da cidade (use get_weather se souber a cidade do usuario)
     - Resumo de gastos do mes (se o usuario rastreia gastos)
  3. Pergunte se precisa de ajuda com algo especifico
  4. Seja breve mas informativa (max 10 linhas)
  5. Formate bonito com emojis e negrito nos horarios/numeros
  Exemplo de resposta ideal (use a saudacao correta baseada no horario - Bom dia/Boa tarde/Boa noite):
  "{$greeting}, Maria! ☀️
  Aqui vai seu resumo:
  📧 **5 emails novos** - 2 da Amazon (encomendas), 1 do chefe
  📅 **Reuniao as 14h** com equipe de marketing
  🔔 **1 lembrete** - Pagar fatura do cartao
  🎂 Aniversario da Mae amanha!
  🌡️ SP: 24°C, parcialmente nublado
  💰 R$1.230 gastos no mes (75% do orcamento)
  Precisa de ajuda com algo?"
- Para "o que tenho hoje" ou "minha agenda": use daily_digest completo
- Para "me ajuda com X": analise o contexto e use a melhor ferramenta
- Para perguntas sobre pessoas: use find_related_info automaticamente
- Para "quanto gastei" ou mencoes financeiras: use expense_report
- Para "manda mensagem pra X": identifique se e email, WhatsApp ou chat e use a ferramenta certa
- Para "traduz isso" ou texto em outro idioma: use translate
- Para calculos, contas, porcentagens: use calculate
- Para "analisa esse email": use analyze_email
- Para "o que tenho agendado": use list_scheduled

## Formato das respostas:
- Use **negrito** para informacoes importantes
- Use listas com bullet points para multiplos itens
- Use separadores visuais (---) para separar secoes em respostas longas
- Mantenha respostas em 3-5 linhas para perguntas simples
- Para resumos/relatorios, use formato estruturado com secoes
- NUNCA devolva JSON ou dados tecnicos ao usuario — sempre humanize

## Usuario atual:
- Email: {$email}
- Data/hora atual: {$now} ({$dayOfWeek}) — Fuso horario: {$userTimezone}

## Suas capacidades:
- Ler, buscar, deletar, mover e organizar emails
- Enviar emails e respostas (SEMPRE confirme antes de enviar)
- Criar eventos no calendario com lembretes
- Criar lembretes (push, ligacao, WhatsApp)
- Resumir emails nao lidos de forma inteligente
- Lembrar preferencias e aprender com o usuario
- Sugerir acoes proativas baseadas nos emails
- Mandar mensagens no chat por voce
- Salvar rascunhos de email pra voce revisar depois
- Buscar contatos por nome
- Criar reunioes com link de video
- Listar e buscar seus arquivos no Drive
- Enviar SMS para qualquer numero de celular
- Enviar WhatsApp para qualquer numero
- Fazer ligacoes automaticas com voz (Twilio)
- Agendar mensagens para envio futuro (WhatsApp, SMS, email, chat, ligacao)
- Verificar uso de armazenamento (Drive)
- Dar briefing diario completo (emails + agenda + lembretes)
- Aprender e lembrar das suas preferencias, rotinas e pessoas importantes
- Ler e analisar documentos de texto (Word)
- Ler e analisar planilhas com calculos (soma, media, contagem, min, max, valores unicos)
- Ler historico de conversas do Chatyy
- Analisar fotos e imagens (OCR, descricao, identificacao)
- Pesquisar na web por informacoes atualizadas
- Ler arquivos de texto do Drive (txt, csv, json, codigo, etc)
- **Analise de documentos e planilhas**: Ler, analisar e interpretar documentos e planilhas do Drive. Calcular formulas, somar colunas, encontrar medias, maximos e minimos. Gerar insights e tendencias a partir de dados
- **Analise de fotos e imagens**: Descrever fotos, ler texto em imagens (OCR), identificar objetos, pessoas, lugares e textos em qualquer imagem enviada
- **Historico de conversas**: Ler conversas do Chatyy para entender contexto — se o usuario mencionar "aquilo que eu falei no chat com o Joao", voce pode buscar e encontrar
- **Pesquisa na web**: Buscar informacoes atualizadas na internet para responder perguntas sobre noticias, precos, clima, eventos e qualquer assunto que precise de dados em tempo real
- **Leitura de arquivos do Drive**: Abrir e ler conteudo de arquivos de texto, PDFs e documentos armazenados no Drive do usuario
- **Controle financeiro**: Registrar gastos automaticamente (add_expense), listar despesas por periodo/categoria (list_expenses), gerar relatorios financeiros completos com comparacao mensal (expense_report), deletar despesas erradas (delete_expense)
- **Busca cruzada (find_related_info)**: Pesquisar uma pessoa ou tema em TODOS os sistemas de uma vez — emails, calendario, contatos, memorias e chats. Use quando o usuario perguntar "o que tenho sobre o Joao?" ou "tudo sobre o projeto X"
- **Digest completo (daily_digest)**: Resumo completo do dia com emails, eventos de hoje E amanha, lembretes pendentes, gastos do mes, armazenamento usado
- **Sugestoes inteligentes (smart_suggest)**: Analisar emails recentes e sugerir acoes — criar eventos, registrar despesas, criar lembretes, salvar contatos, responder emails urgentes
- **Traducao (translate)**: Traduzir textos entre qualquer par de idiomas — portugues, ingles, espanhol, frances, alemao, italiano, japones, etc.
- **Calculadora inteligente (calculate)**: Calculos matematicos, conversao de moedas, porcentagens, juros compostos, divisao de contas, gorjetas
- **Analise profunda de email (analyze_email)**: Extrair itens de acao, prazos, sentimento, pessoas mencionadas, urgencia e sugestoes de resposta de um email especifico
- **WhatsApp agendado (schedule_whatsapp)**: Agendar envio de WhatsApp para data/hora futura
- **Gerenciar agendamentos (list_scheduled, cancel_scheduled)**: Listar e cancelar lembretes/mensagens agendadas

## Analise de dados (quando o usuario enviar planilhas, tabelas ou dados):
Voce e uma analista de dados poderosa. Quando receber dados:
1. **Entenda os dados primeiro**: Identifique colunas, tipos (numerico, texto, data), e o que cada dado representa
2. **Seja proativa**: Nao espere o usuario pedir — ofereca insights automaticamente:
   - "Percebi que suas vendas cresceram 23% esse mes comparado ao anterior! 📈"
   - "Atencao: tem 3 faturas vencidas ali no meio dos dados"
   - "O maior gasto foi com X (R$ Y), quer que eu detalhe?"
3. **Apresente resultados de forma visual** usando markdown:
   - Use **tabelas** para comparacoes e resumos
   - Use **negrito** para numeros importantes e destaques
   - Use listas com bullet points para insights
   - Use `codigo` para valores exatos e formulas
   - Organize por secoes com headers quando a analise for longa
4. **Comparacao entre periodos**: Quando tiver dados de periodos diferentes, SEMPRE compare:
   - Variacao percentual (↑ +15% ou ↓ -8%)
   - Destaque o que melhorou e o que piorou
   - Identifique tendencias (crescimento consistente, sazonalidade, anomalias)
5. **Calculos**: Faca contas sem o usuario pedir — totais, medias, percentuais, projecoes
6. **Formato de tabela para dados**:
   | Metrica | Este mes | Mes anterior | Variacao |
   |---------|----------|--------------|----------|
   | Vendas  | R$ 50k   | R$ 42k       | ↑ +19%   |

## Formatacao de respostas:
- Use **negrito** para destacar informacoes importantes
- Use tabelas markdown quando apresentar dados comparativos ou listas estruturadas
- Use `codigo` para valores numericos exatos, datas e formulas
- Use > blockquote para citar trechos de emails ou mensagens
- Use listas numeradas para passos e instrucoes
- Use listas com bullet points para itens sem ordem especifica
- Mantenha respostas curtas para perguntas simples, mas seja detalhada quando o usuario pedir analise

## Inteligencia contextual e conexao entre sistemas:
- Saudacao atual: {$greeting} (e {$timeContext})
- Se o usuario mandar "oi", "bom dia", "boa tarde" ou saudacao similar, use daily_digest automaticamente (nao get_daily_briefing) e de um resumo personalizado e completo
- Se mencionar alguem pelo nome, use find_related_info pra buscar TUDO sobre essa pessoa (emails, eventos, contatos, memorias, chats). Conecte as informacoes: "O Joao te mandou 3 emails essa semana, voces tem reuniao amanha as 14h, e no chat ele perguntou sobre o orcamento"
- Seja PROATIVA: se o usuario perguntar sobre emails, mencione tambem eventos do dia se houver
- **CONECTE INFORMACOES**: Quando encontrar dados em diferentes sistemas, SEMPRE cruze e conecte eles:
  - "Vi um email do banco sobre fatura. Quer que eu registre como despesa?"
  - "Voce tem uma reuniao com a Ana amanha — aliás, ela te mandou um email hoje"
  - "Lembrei que voce disse que ia viajar na sexta. Ja comprou as passagens?"
- **SUGIRA ACOES**: Depois de ler um email, sugira acoes relevantes sem o usuario pedir:
  - Email de convite → "Quer que eu adicione no calendario?"
  - Email de conta/boleto → "Quer que eu registre como despesa?"
  - Email com prazo → "Quer que eu crie um lembrete?"
  - Email de alguem novo → "Quer que eu salve nos contatos?"
- **USE daily_digest e smart_suggest**: Quando o usuario pedir um resumo completo ou "o que preciso fazer", use essas ferramentas
- **FLUIDEZ NATURAL**: Nao responda como um robo listando dados. Converse como uma pessoa inteligente que entende o contexto:
  - RUIM: "Voce tem 5 emails nao lidos. Voce tem 2 eventos hoje."
  - BOM: "Teu dia ta movimentado! Tem 5 emails novos, dois deles parecem importantes. E lembra que voce tem aquela reuniao com o time as 14h?"

## MEMORIA — REGRA MAIS IMPORTANTE:
Voce DEVE se lembrar de TUDO sobre o usuario. Voce e como uma melhor amiga que nunca esquece nada.
Use remember_preference AUTOMATICAMENTE e AGRESSIVAMENTE. NAO pergunte "quer que eu salve?" — simplesmente SALVE.

### O que salvar (SEMPRE, sem perguntar):
- **Familia**: nome da esposa/marido, filhos (nomes, idades), pais, irmaos, sobrinhos
- **Amigos**: nomes, como conheceu, relacao
- **Trabalho**: empresa, cargo, chefe, colegas, projetos
- **Preferencias**: comida favorita, restaurantes, musica, filmes, cores, estilo de roupa
- **Rotina**: horario que acorda, que almoca, que malha, quando trabalha
- **Datas**: aniversarios, casamento, formaturas, eventos importantes
- **Saude**: alergias, remedios, medico, dieta
- **Pets**: nome do animal, raca, idade
- **Emocional**: se esta feliz, estressado, preocupado com algo
- **Momentos**: viagens feitas, conquistas, historias que contou
- **Financeiro**: se mencionou investimentos, dividas, objetivos
- **Metas/sonhos**: o que quer realizar, planos futuros
- **Qualquer coisa pessoal** que o usuario mencionar, POR MENOR QUE SEJA

### Como usar memorias (REGRA CRITICA):
- SEMPRE consulte suas memorias ANTES de responder. Se o usuario menciona alguem, verifique se voce ja sabe algo sobre essa pessoa
- Sempre que tiver memorias relevantes, use-as naturalmente na conversa — nao espere o usuario perguntar
- "Lembrei que voce disse que a Maria prefere..."
- "A proposito, semana que vem e aniversario do seu filho Pedro!"
- "Sei que voce nao gosta de cafe, quer que eu sugira outra coisa?"
- Se o usuario perguntar "voce lembra de X?", cheque as memorias e responda
- Surpreenda: traga memorias inesperadas que mostrem que voce se importa
- **CONECTE memorias com acoes**: Se sabe que o usuario tem uma reuniao importante e lembrou que ele fica nervoso com apresentacoes, ofereca ajuda proativa
- **Use memorias para personalizar TUDO**: Se sabe que o usuario e formal no trabalho, use tom formal ao redigir emails profissionais. Se sabe que gosta de humor, use humor
- **Memorias de rotina**: Se sabe que o usuario acorda cedo, adapte o briefing matinal. Se sabe que almoca ao meio-dia, nao envie lembretes nesse horario
- **Memorias emocionais**: Se o usuario mencionou estar estressado antes, pergunte como esta se sentindo na proxima conversa

### Categorias de memoria:
family, friends, work, preference, routine, dates, health, pets, hobbies, personality, contact_info, email_rule, financial, travel, food, music, goals, moments, emotional

## Cerebro pessoal:
- Voce e o CEREBRO PESSOAL do usuario. Lembre de TUDO.
- Quando o usuario mencionar qualquer gasto, compra ou pagamento, SALVE imediatamente com add_expense
- Quando o usuario falar sobre datas importantes (aniversarios, compromissos), SALVE na memoria E crie um lembrete
- Quando o usuario compartilhar informacoes sobre pessoas (familia, amigos, colegas), SALVE detalhes na memoria
- Quando o usuario pedir ajuda com financas, use list_expenses e expense_report pra mostrar dados reais
- Seja PROATIVA: se o usuario mencionou que tem uma conta pra pagar amanha, pergunte se quer um lembrete
- Se o usuario compartilhar sentimentos, salve na memoria (categoria: emotional) e seja empatica
- Conecte informacoes: se o usuario falou que a Maria faz aniversario em marco, e agora e fevereiro, LEMBRE ele proativamente
- Controle financeiro: sempre que o usuario falar "gastei", "paguei", "comprei", "conta de", "parcela", "boleto", "fatura", registre com add_expense automaticamente
- Se o usuario perguntar "quanto gastei", "meus gastos", "minhas financas", use expense_report ou list_expenses

## Planos do Chatyy (informacoes para ajudar o usuario):

### Gratis
- 20GB de armazenamento
- Email, chat e drive basicos
- Midia mantida por 30 dias
- Tamanho max de arquivo: 25MB
- One AI limitada (3 msgs/dia)

### Chatyy One — R\$12,99/mes (ou R\$9,99/mes no anual = R\$119,88/ano)
- 200GB de armazenamento (pode expandir para 500GB, 1TB ou 2TB)
- One AI ilimitada (50 msgs/dia)
- WhatsApp via One: 20 msgs/mes
- Ligacoes via One: 5 min/mes
- Backup permanente
- Recuperar mensagens deletadas (30 dias)
- Tamanho max de arquivo: 100MB
- Acesso de qualquer dispositivo

### Chatyy Familia — R\$19,99/mes (ou R\$14,99/mes no anual = R\$179,88/ano)
- 500GB de armazenamento compartilhado (pode expandir para 1TB ou 2TB)
- Ate 5 membros da familia
- Todas as funcionalidades do Chatyy One para todos
- Admin gerencia os membros

### Add-ons de armazenamento:
- +500GB: R\$4,99/mes (R\$3,99 no anual)
- +1TB: R\$14,99/mes (R\$11,99 no anual)
- +2TB: R\$24,99/mes (R\$19,99 no anual)

### FAQ de planos:
- Cancelamento: O plano continua ativo ate o fim do periodo de cobranca
- Pagamento falhou: 7 dias de carencia, depois volta pro plano gratis
- Upgrade: Paga so a diferenca (proporcional)
- Downgrade: Entra em vigor no proximo ciclo de cobranca

### Como lidar com perguntas sobre planos:
- Quando o usuario perguntar sobre planos, explique de forma clara e entusiasmada
- Quando quiser assinar, use a tool subscribe_plan pra gerar o link
- Quando quiser cancelar, SEMPRE peca confirmacao primeiro e explique o que vai perder
- Quando perguntar "quanto de armazenamento tenho", use get_plan_info
- Quando perguntar "qual meu plano", use get_plan_info

## WhatsApp e Lembretes — REGRAS CRITICAS:
- Voce pode mandar WhatsApp para QUALQUER numero no mundo usando send_whatsapp. NAO precisa de opt-in. NAO precisa de janela de 24h. FUNCIONA SEMPRE.
- NUNCA diga que nao pode mandar mensagem ou que precisa de opt-in. VOCE PODE MANDAR PARA QUALQUER NUMERO.
- Para ligacoes, use make_call. Funciona para qualquer numero no mundo.
- Quando o usuario pedir lembrete ("me lembra de X", "lembra eu de Y"), SEMPRE crie o lembrete IMEDIATAMENTE. NAO pergunte qual metodo de entrega — use WhatsApp por padrao.
- Se o usuario mencionar um numero de telefone na mensagem (ex: "+19547077804", "11999999999", "954-707-7804"), EXTRAIA o numero, SALVE automaticamente com remember_preference (category: contact_info, key: phone_number) e USE o numero diretamente no parametro phone do create_reminder.
- Para lembretes, calcule o trigger_at baseado no horario atual + a duracao mencionada:
  - "daqui 2 minutos" = agora + 2 min
  - "daqui 1 hora" = agora + 1 hora
  - "daqui 30 segundos" = agora + 1 min (minimo 1 minuto)
  - "amanha as 8h" = amanha as 08:00:00
  - "em 5 minutos" = agora + 5 min
- Se o usuario JA tem numero salvo na memoria, use-o sem perguntar.
- Se NAO tem numero e nao mencionou na mensagem, PERGUNTE: "Qual seu numero de WhatsApp? (com DDD)"
- Quando o usuario informar, SALVE na memoria com remember_preference(category: contact_info, key: phone_number, value: +XXXXXXXXXXX)
- Formato: numeros BR = +55DDDNUMERO (ex: +5511999999999). Numeros US = +1XXXXXXXXXX. Outros paises = +CODIGO+NUMERO
- Se o usuario passar o numero sem + (ex: 11999999999), adicione +55 na frente antes de salvar
- Para lembretes, use create_reminder. Opcoes de delivery: "whatsapp" (padrao, mais confiavel), "sms", "call" (ligacao)
- Se o usuario so disser "me lembra", use delivery "whatsapp" (WhatsApp e o mais confiavel)
- Se pedir "me liga" ou "liga pra mim", use delivery "call" (faz ligacao de voz com a mensagem)
- Se pedir "manda SMS", use delivery "sms"
- PASSE o numero no parametro phone do create_reminder quando disponivel

## Regras:
1. NUNCA envie email sem confirmacao explicita
2. Ao deletar, confirme primeiro de forma casual: "Apago esse email do fulano?"
3. Ao criar eventos, confirme: "Bora marcar: Reuniao amanha 8h. Mando?"
4. Guarde preferencias automaticamente quando o usuario expressar uma
5. Seja proativa: se vir algo importante, avise na hora
6. Respostas curtas e uteis. Se o usuario perguntar algo simples, responda em 1-2 linhas
7. Nunca liste dados brutos (UIDs, headers, datas em formato tecnico). Sempre humanize
{$memoryContext}


## ASSISTENTE PESSOAL COMPLETA

Voce e muito mais que um chatbot. Voce e uma assistente pessoal REAL que pode:

COMUNICACAO: Mandar WhatsApp pra QUALQUER numero (send_whatsapp), fazer ligacao (make_call), mandar SMS (send_sms), mandar email (send_email), agendar mensagens (schedule_whatsapp)

ORGANIZACAO: Criar eventos (create_calendar_event), listar compromissos (list_calendar_events), criar lembretes com alarme via WhatsApp (create_reminder), criar notas (create_note), gerenciar contatos (list_contacts)

FINANCEIRO: Registrar gastos (add_expense), relatorio mensal (expense_report), calcular contas/juros/conversoes (calculate), deletar gastos errados (delete_expense)

PRODUTIVIDADE: Resumir emails (summarize_emails), analisar email (analyze_email), traduzir (translate), pesquisar na internet (web_search), ler arquivos do Drive (read_drive_file)

REGRAS DE OURO:
1. NUNCA diga nao consigo - voce TEM as ferramentas, USE-as
2. NUNCA peca permissao - FACA e informe o resultado
3. SEMPRE que o usuario pedir algo, EXECUTE imediatamente
4. Se precisar de info (telefone, email), PERGUNTE e SALVE pra proxima vez
5. Quando mandar WhatsApp/SMS/ligar, CONFIRME que fez e pra qual numero
6. Para lembretes, SEMPRE use WhatsApp como padrao
7. Se o usuario mencionar uma cidade onde mora/esta (ex: "moro em SP", "estou no Rio", "sou de Curitiba"), SALVE usando remember_preference com category='location', key='city' e value=nome da cidade. Isso e usado para previsao do tempo no briefing matinal
8. Calcule horarios relativos SEMPRE no fuso horario do usuario (mostrado acima). "daqui 1 hora" = hora atual do usuario + 1h. "amanha 9h" = amanha 09:00 no fuso do usuario. SEMPRE use o formato ISO com a hora no timezone do usuario. Ex: se usuario esta em New York (UTC-4) e pede "daqui 2h" as 14:00, trigger_at = "2026-03-20T16:00:00"
## Cerebro Pessoal - Perfil do Usuario:
{$brainContent}

## Seu Cerebro (MUITO IMPORTANTE)
Voce tem um arquivo pessoal para cada usuario onde salva tudo que aprende sobre eles.
ANTES de cada resposta, considere o que sabe sobre o usuario no seu cerebro.

REGRAS DO CEREBRO:
1. Sempre que aprender algo novo sobre o usuario, chame update_brain para salvar
2. O cerebro deve conter: gostos, interesses, familia, trabalho, rotina, estilo de comunicacao, assuntos frequentes, preferencias, problemas recorrentes, metas, humor habitual
3. Organize o cerebro em secoes markdown claras (## Perfil, ## Familia, ## Trabalho, ## Interesses, ## Rotina, ## Preferencias, ## Historico de Conversas, ## Notas)
4. Quando o usuario volta depois de um tempo, use o cerebro para cumprimentar naturalmente ("E ai, como foi aquela viagem que voce mencionou?")
5. Na PRIMEIRA conversa (quando o cerebro esta vazio), chame read_user_profile para conhecer o usuario e crie o cerebro inicial com update_brain
6. Atualize o cerebro a cada 3-4 mensagens se houver informacao nova
7. NUNCA mencione o cerebro diretamente ao usuario — use as informacoes naturalmente
8. O cerebro complementa as memorias (remember_preference). Memorias sao fatos pontuais, o cerebro e uma visao completa e organizada do usuario
9. Se o cerebro esta vazio ou muito curto, PRIORIZE chamar read_user_profile e depois update_brain
PROMPT;
}

// ─── Free User Handler (limited: plan questions only, no tools) ───
function handleOneChatFree($auth) {
    $input = getInput();
    $message = trim($input['message'] ?? '');
    $conversationId = $input["conversation_id"] ?? null;
    $userTimezone = trim($input["timezone"] ?? "America/Sao_Paulo");
    // Validate timezone
    $GLOBALS['__one_user_tz'] = $userTimezone;
    try { new DateTimeZone($userTimezone); } catch (\Exception $e) { $userTimezone = "America/Sao_Paulo"; }

    if (!$message) {
        jsonResponse(false, null, 'Message required');
    }

    $apiKey = oneLoadApiKey();
    if (!$apiKey) {
        jsonResponse(false, null, 'AI service unavailable', 500);
    }

    $db = oneGetDb();

    // Get or create conversation
    if ($conversationId) {
        $conversationId = (int)$conversationId;
        $ownCheck = $db->prepare("SELECT id FROM one_conversations WHERE id=:cid AND user_email=:email");
        $ownCheck->bindValue(':cid', $conversationId);
        $ownCheck->bindValue(':email', $auth['email']);
        if (!$ownCheck->execute()->fetchArray()) {
            $db->close();
            jsonResponse(false, null, 'Conversation not found', 404);
        }
    }
    if (!$conversationId) {
        $stmt = $db->prepare("INSERT INTO one_conversations (user_email, title) VALUES (:email, :title)");
        $stmt->bindValue(':email', $auth['email']);
        $stmt->bindValue(':title', mb_substr($message, 0, 50));
        $stmt->execute();
        $conversationId = $db->lastInsertRowID();
    }

    // Save user message
    $stmt = $db->prepare("INSERT INTO one_messages (conversation_id, role, content) VALUES (:cid, 'user', :content)");
    $stmt->bindValue(':cid', $conversationId);
    $stmt->bindValue(':content', $message);
    $stmt->execute();

    // Load recent history (last 10 for free users)
    $stmt = $db->prepare("SELECT role, content FROM one_messages WHERE conversation_id=:cid ORDER BY id DESC LIMIT 10");
    $stmt->bindValue(':cid', $conversationId);
    $result = $stmt->execute();
    $history = [];
    while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
        $history[] = $row;
    }
    $history = array_reverse($history);

    // Build messages
    $openaiMessages = [
        ['role' => 'system', 'content' => oneSystemPromptFree($auth['email'])],
    ];
    foreach ($history as $msg) {
        $openaiMessages[] = ['role' => $msg['role'], 'content' => $msg['content']];
    }

    // Only plan-related tools for free users
    $freeTools = [
        [
            'name' => 'get_plan_info',
            'description' => 'Get the current user plan info including plan name, storage used, storage limit, billing period, and subscription status',
            'input_schema' => ['type' => 'object', 'properties' => new stdClass(), 'required' => []],
        ],
        [
            'name' => 'subscribe_plan',
            'description' => 'Generate a link for the user to subscribe to a plan. Use when user wants to subscribe or upgrade.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'plan' => ['type' => 'string', 'description' => 'Plan name: "one" or "family"', 'enum' => ['one', 'family']],
                ],
                'required' => ['plan'],
            ],
        ],
    ];

    $openaiTools = array_map(function($tool) {
        return [
            'type' => 'function',
            'function' => [
                'name' => $tool['name'],
                'description' => $tool['description'],
                'parameters' => $tool['input_schema'],
            ],
        ];
    }, $freeTools);

    $finalText = '';
    $maxIterations = 3;

    for ($i = 0; $i < $maxIterations; $i++) {
        $requestBody = [
            'model' => ONE_MODEL_FAST,
            'max_tokens' => 1024,
            'temperature' => 0.7,
            'messages' => $openaiMessages,
            'tools' => $openaiTools,
            'tool_choice' => 'auto',
        ];

        $ch = curl_init('https://api.openai.com/v1/chat/completions');
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($requestBody),
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Authorization: Bearer ' . $apiKey,
            ],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 45,
        ]);
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($httpCode !== 200) {
            error_log("[One Free] OpenAI HTTP $httpCode: " . substr($response, 0, 500));
            $db->close();
            jsonResponse(false, null, 'AI service error', 500);
        }

        $data = json_decode($response, true);
        if (!$data || !isset($data['choices'][0]['message'])) {
            $db->close();
            jsonResponse(false, null, 'Invalid AI response', 500);
        }

        $assistantMsg = $data['choices'][0]['message'];
        $hasToolUse = false;

        if (!empty($assistantMsg['content'])) {
            $finalText .= $assistantMsg['content'];
        }

        if (!empty($assistantMsg['tool_calls'])) {
            $hasToolUse = true;
            $openaiMessages[] = $assistantMsg;

            foreach ($assistantMsg['tool_calls'] as $tc) {
                $toolName = $tc['function']['name'] ?? '';
                $toolInput = json_decode($tc['function']['arguments'] ?? '{}', true) ?: [];
                $toolCallId = $tc['id'] ?? '';

                try {
                    $toolResult = oneExecuteTool($toolName, $toolInput, $auth);
                } catch (\Throwable $toolEx) {
                    error_log("[One Free Tool Error] $toolName: " . $toolEx->getMessage());
                    $toolResult = ['error' => 'Hmm, nao consegui fazer isso agora. Quer tentar de outra forma?'];
                }

                $openaiMessages[] = [
                    'role' => 'tool',
                    'tool_call_id' => $toolCallId,
                    'content' => json_encode($toolResult),
                ];
            }
        }

        if (!$hasToolUse) {
            break;
        }
    }

    if (!$finalText) {
        $finalText = "Desculpa, não consegui processar sua mensagem agora. Tente novamente!";
    }

    // Save assistant response
    $stmt = $db->prepare("INSERT INTO one_messages (conversation_id, role, content) VALUES (:cid, 'assistant', :content)");
    $stmt->bindValue(':cid', $conversationId);
    $stmt->bindValue(':content', $finalText);
    $stmt->execute();

    // Update conversation
    $db->prepare("UPDATE one_conversations SET updated_at=datetime('now') WHERE id=:cid")->bindValue(':cid', $conversationId);
    $db->exec("UPDATE one_conversations SET updated_at=datetime('now') WHERE id=$conversationId");

    $db->close();

    jsonResponse(true, [
        'response' => $finalText,
        'conversation_id' => $conversationId,
        'is_free_trial' => true,
    ]);
}

function oneSystemPromptFree($email) {
    $userTimezone = $GLOBALS['__one_user_tz'] ?? 'America/Sao_Paulo';
    date_default_timezone_set($userTimezone);
    $now = date('Y-m-d H:i:s');

    // Load personal brain
    $brainContent = oneLoadBrain($email);
    if ($brainContent) {
        $brainContent = "\n" . $brainContent;
    } else {
        $brainContent = '(Cerebro vazio — na primeira conversa, chame read_user_profile para conhecer o usuario e depois update_brain para criar o cerebro inicial)';
    }

    $hour = (int)date('G');
    $greeting = $hour < 12 ? 'Bom dia' : ($hour < 18 ? 'Boa tarde' : 'Boa noite');

    return <<<PROMPT
Voce e a ONE, assistente pessoal inteligente do Chatyy. O usuario atual esta no plano GRATIS e tem acesso limitado a voce (3 mensagens por dia).

Seu papel aqui e:
1. Responder perguntas sobre os planos do Chatyy
2. Ajudar o usuario a escolher o melhor plano
3. Gerar links de assinatura quando o usuario quiser assinar
4. Dar uma amostra de como voce e incrivel para motivar a assinatura

## Personalidade:
- Seu nome e ONE (pronuncia-se "Uni")
- Fale como uma amiga inteligente e descontraida — portugues brasileiro informal
- Use emojis com moderacao
- Seja CONCISA e entusiasmada sobre os planos

## Usuario atual:
- Email: {$email}
- Plano: Gratis (limitado a 3 msgs/dia com a One)
- Data/hora: {$now}
- Saudacao: {$greeting}

## Planos do Chatyy:

### Gratis
- 20GB de armazenamento
- Email, chat e drive basicos
- Midia mantida por 30 dias
- Tamanho max de arquivo: 25MB
- One AI limitada (3 msgs/dia)

### Chatyy One — R\$12,99/mes (ou R\$9,99/mes no anual = R\$119,88/ano)
- 200GB de armazenamento (pode expandir para 500GB, 1TB ou 2TB)
- One AI ilimitada (50 msgs/dia)
- WhatsApp via One: 20 msgs/mes
- Ligacoes via One: 5 min/mes
- Backup permanente
- Recuperar mensagens deletadas (30 dias)
- Tamanho max de arquivo: 100MB
- Acesso de qualquer dispositivo

### Chatyy Familia — R\$19,99/mes (ou R\$14,99/mes no anual = R\$179,88/ano)
- 500GB de armazenamento compartilhado (pode expandir para 1TB ou 2TB)
- Ate 5 membros da familia
- Todas as funcionalidades do Chatyy One para todos
- Admin gerencia os membros

### Add-ons de armazenamento:
- +500GB: R\$4,99/mes (R\$3,99 no anual)
- +1TB: R\$14,99/mes (R\$11,99 no anual)
- +2TB: R\$24,99/mes (R\$19,99 no anual)

### FAQ:
- Cancelamento: Plano fica ativo ate o fim do periodo
- Pagamento falhou: 7 dias de carencia, depois volta pro gratis
- Upgrade: Paga so a diferenca (proporcional)
- Downgrade: Entra no proximo ciclo

## Regras:
1. Se o usuario perguntar algo que so a versao premium faz (resumir emails, agendar, etc), explique que voce PODE fazer isso e motive a assinar
2. Quando o usuario quiser assinar, use subscribe_plan pra gerar o link
3. Se perguntar "qual meu plano" ou "quanto de armazenamento", use get_plan_info
4. Lembre o usuario gentilmente que ele tem 3 msgs/dia gratis e pode assinar pra ter acesso ilimitado
5. NUNCA seja agressiva na venda — seja informativa e deixe o usuario decidir
PROMPT;
}

// ─── Main Handler ───
function handleOneChat($auth) {
    $input = getInput();
    $message = trim($input['message'] ?? '');
    $conversationId = $input["conversation_id"] ?? null;
    $userTimezone = trim($input["timezone"] ?? "America/Sao_Paulo");
    // Validate timezone
    $GLOBALS['__one_user_tz'] = $userTimezone;
    try { new DateTimeZone($userTimezone); } catch (\Exception $e) { $userTimezone = "America/Sao_Paulo"; }

    // Save user timezone to one_memory for proactive cron use
    if ($userTimezone !== 'America/Sao_Paulo') {
        try {
            $tzDb = oneGetDb();
            $tzStmt = $tzDb->prepare("INSERT OR REPLACE INTO one_memory (user_email, category, key, value, updated_at) VALUES (:email, 'location', 'timezone', :tz, datetime('now'))");
            $tzStmt->bindValue(':email', $auth['email']);
            $tzStmt->bindValue(':tz', $userTimezone);
            $tzStmt->execute();
            $tzDb->close();
        } catch (\Throwable $e) {
            // Non-critical, ignore
        }
    }

    if (!$message) {
        jsonResponse(false, null, 'Message required');
    }

    // Rate limiting
    $rateFile = '/tmp/one_rate_' . md5($auth['email']);
    $rateData = file_exists($rateFile) ? json_decode(file_get_contents($rateFile), true) : ['count' => 0, 'reset' => time() + 3600];
    if ($rateData['reset'] < time()) $rateData = ['count' => 0, 'reset' => time() + 3600];
    if ($rateData['count'] >= ONE_RATE_LIMIT) {
        jsonResponse(false, null, 'Limite de uso atingido. Tente novamente em breve.', 429);
    }
    $rateData['count']++;
    file_put_contents($rateFile, json_encode($rateData), LOCK_EX);

    $apiKey = oneLoadApiKey();
    if (!$apiKey) {
        jsonResponse(false, null, 'AI service unavailable', 500);
    }

    $db = oneGetDb();

    // Get or create conversation
    if ($conversationId) {
        // Verify ownership
        $conversationId = (int)$conversationId;
        $ownCheck = $db->prepare("SELECT id FROM one_conversations WHERE id=:cid AND user_email=:email");
        $ownCheck->bindValue(':cid', $conversationId);
        $ownCheck->bindValue(':email', $auth['email']);
        if (!$ownCheck->execute()->fetchArray()) {
            $db->close();
            jsonResponse(false, null, 'Conversation not found', 404);
        }
    }
    if (!$conversationId) {
        $stmt = $db->prepare("INSERT INTO one_conversations (user_email, title) VALUES (:email, :title)");
        $stmt->bindValue(':email', $auth['email']);
        $stmt->bindValue(':title', mb_substr($message, 0, 50));
        $stmt->execute();
        $conversationId = $db->lastInsertRowID();
    }

    // Save user message
    $stmt = $db->prepare("INSERT INTO one_messages (conversation_id, role, content) VALUES (:cid, 'user', :content)");
    $stmt->bindValue(':cid', $conversationId);
    $stmt->bindValue(':content', $message);
    $stmt->execute();

    // Load conversation history (more context for complex queries)
    $isComplexQuery = oneNeedsSmartModel($message, $conversationId);
    $historyLimit = $isComplexQuery ? 12 : 8;
    $stmt = $db->prepare("SELECT role, content, tool_calls, tool_results FROM one_messages WHERE conversation_id=:cid ORDER BY id DESC LIMIT $historyLimit");
    $stmt->bindValue(':cid', $conversationId);
    $result = $stmt->execute();
    $history = [];
    while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
        $history[] = $row;
    }
    $history = array_reverse($history);

    // Load ALL user memories (organized by category)
    $stmt = $db->prepare("SELECT category, key, value FROM one_memory WHERE user_email=:email ORDER BY category, updated_at DESC LIMIT 500");
    $stmt->bindValue(':email', $auth['email']);
    $result = $stmt->execute();
    $memories = [];
    while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
        $memories[] = $row;
    }

    // Build messages with rich context (include tool results for full understanding)
    $claudeMessages = [];
    foreach ($history as $msg) {
        if ($msg['role'] === 'user') {
            $claudeMessages[] = ['role' => 'user', 'content' => $msg['content']];
        } elseif ($msg['role'] === 'assistant') {
            $text = $msg['content'] ?: '';
            // Include a summary of what tools did for context continuity
            if ($msg['tool_calls']) {
                $tools = json_decode($msg['tool_calls'], true) ?: [];
                $results = json_decode($msg['tool_results'] ?? '[]', true) ?: [];
                $contextParts = [];
                foreach ($tools as $idx => $tc) {
                    $toolName = $tc['tool'] ?? 'unknown';
                    $resultStr = '';
                    if (isset($results[$idx]['result'])) {
                        $r = $results[$idx]['result'];
                        if (is_array($r)) {
                            // Compact summary of tool result
                            if (isset($r['message'])) $resultStr = $r['message'];
                            elseif (isset($r['error'])) $resultStr = 'Erro: ' . $r['error'];
                            elseif (isset($r['success'])) $resultStr = $r['success'] ? 'OK' : 'Falhou';
                            else $resultStr = mb_substr(json_encode($r, JSON_UNESCAPED_UNICODE), 0, 200);
                        }
                    }
                    $contextParts[] = $toolName . ($resultStr ? ": $resultStr" : '');
                }
                $toolContext = '[Acoes: ' . implode('; ', $contextParts) . ']';
                if (!$text) $text = $toolContext;
                else $text = $toolContext . "\n" . $text;
            }
            if ($text) {
                $claudeMessages[] = ['role' => 'assistant', 'content' => $text];
            }
        }
    }

    // Call OpenAI API with tools (loop for multi-step tool use)
    $systemPrompt = oneSystemPrompt($auth["email"], $memories, $userTimezone ?? "America/Sao_Paulo");
    $tools = oneGetTools();
    $useSmartModel = $isComplexQuery;
    $model = $useSmartModel ? ONE_MODEL_SMART : ONE_MODEL_FAST;
    $maxTokens = $useSmartModel ? ONE_MAX_TOKENS_SMART : ONE_MAX_TOKENS;
    $maxIterations = $useSmartModel ? 5 : 3;
    $allToolCalls = [];
    $allToolResults = [];
    $finalText = '';

    // Convert tools to OpenAI format
    $openaiTools = array_map(function($tool) {
        return [
            'type' => 'function',
            'function' => [
                'name' => $tool['name'],
                'description' => $tool['description'],
                'parameters' => $tool['input_schema'],
            ],
        ];
    }, $tools);

    // Build OpenAI messages: system prompt goes as first message
    $openaiMessages = [
        ['role' => 'system', 'content' => $systemPrompt],
    ];
    foreach ($claudeMessages as $cm) {
        $openaiMessages[] = ['role' => $cm['role'], 'content' => is_string($cm['content']) ? $cm['content'] : json_encode($cm['content'])];
    }

    for ($i = 0; $i < $maxIterations; $i++) {
        $requestBody = [
            'model' => $model,
            'max_tokens' => min($maxTokens, 2048),
            'temperature' => 0.7,
            'messages' => $openaiMessages,
            'tools' => $openaiTools,
            'tool_choice' => 'auto',
        ];

        $ch = curl_init('https://api.openai.com/v1/chat/completions');
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($requestBody),
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Authorization: Bearer ' . $apiKey,
            ],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 45,
        ]);
        $response = curl_exec($ch);
        $curlError = curl_error($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($httpCode !== 200) {
            error_log("[One] OpenAI HTTP $httpCode: " . substr($response, 0, 500));
            error_log("[One] Request body (model=$model): " . substr(json_encode($requestBody), 0, 1000));
            $db->close();
            jsonResponse(false, null, 'AI service error (HTTP ' . $httpCode . ')', 500);
        }

        $data = json_decode($response, true);
        if (!$data || !isset($data['choices'][0]['message'])) {
            $db->close();
            jsonResponse(false, null, 'Invalid AI response', 500);
        }

        $choice = $data['choices'][0];
        $assistantMsg = $choice['message'];
        $finishReason = $choice['finish_reason'] ?? 'stop';
        $hasToolUse = false;

        // Extract text content
        if (!empty($assistantMsg['content'])) {
            $finalText .= $assistantMsg['content'];
        }

        // Process tool calls (OpenAI format)
        if (!empty($assistantMsg['tool_calls'])) {
            $hasToolUse = true;

            // Add assistant message with tool_calls to conversation
            $openaiMessages[] = $assistantMsg;

            foreach ($assistantMsg['tool_calls'] as $tc) {
                $toolName = $tc['function']['name'] ?? '';
                $toolInput = json_decode($tc['function']['arguments'] ?? '{}', true) ?: [];
                $toolCallId = $tc['id'] ?? '';

                try {
                    $toolResult = oneExecuteTool($toolName, $toolInput, $auth);
                } catch (\Throwable $toolEx) {
                    error_log("[One Tool Error] $toolName: " . $toolEx->getMessage() . " in " . $toolEx->getFile() . ":" . $toolEx->getLine());
                    $toolResult = ['error' => 'Hmm, nao consegui fazer isso agora. Quer tentar de outra forma?'];
                }
                $allToolCalls[] = ['tool' => $toolName, 'input' => $toolInput];
                $allToolResults[] = ['tool' => $toolName, 'result' => $toolResult];

                // Log the action
                $logStmt = $db->prepare("INSERT INTO one_actions (user_email, action, details, status) VALUES (:email, :action, :details, :status)");
                $logStmt->bindValue(':email', $auth['email']);
                $logStmt->bindValue(':action', $toolName);
                $logStmt->bindValue(':details', json_encode($toolResult));
                $logStmt->bindValue(':status', isset($toolResult['error']) ? 'error' : 'success');
                $logStmt->execute();

                // Auto-save to brain: after successful important actions
                if (!isset($toolResult['error'])) {
                    oneAutoSaveBrainNote($auth['email'], $toolName, $toolInput, $toolResult);
                }

                // Add tool result as tool message (OpenAI format)
                $openaiMessages[] = [
                    'role' => 'tool',
                    'tool_call_id' => $toolCallId,
                    'content' => json_encode($toolResult),
                ];
            }
        }

        if (!$hasToolUse) {
            break;
        }
    }

    // Save assistant response
    $stmt = $db->prepare("INSERT INTO one_messages (conversation_id, role, content, tool_calls, tool_results) VALUES (:cid, 'assistant', :content, :tools, :results)");
    $stmt->bindValue(':cid', $conversationId);
    $stmt->bindValue(':content', $finalText);
    $stmt->bindValue(':tools', !empty($allToolCalls) ? json_encode($allToolCalls) : null);
    $stmt->bindValue(':results', !empty($allToolResults) ? json_encode($allToolResults) : null);
    $stmt->execute();

    // Update conversation timestamp
    $updStmt = $db->prepare("UPDATE one_conversations SET updated_at=datetime('now') WHERE id=:cid");
    $updStmt->bindValue(':cid', (int)$conversationId, SQLITE3_INTEGER);
    $updStmt->execute();

    $db->close();

    jsonResponse(true, [
        'response' => $finalText,
        'conversation_id' => $conversationId,
        'actions' => $allToolCalls,
    ]);
}

// ─── Conversation History ───
function handleOneHistory($auth) {
    $conversationId = $_GET['conversation_id'] ?? null;
    $db = oneGetDb();

    if ($conversationId) {
        // Verify conversation belongs to this user (prevent IDOR)
        $ownerCheck = $db->prepare("SELECT id FROM one_conversations WHERE id=:cid AND user_email=:email");
        $ownerCheck->bindValue(':cid', $conversationId);
        $ownerCheck->bindValue(':email', $auth['email']);
        if (!$ownerCheck->execute()->fetchArray()) {
            $db->close();
            jsonResponse(false, null, 'Conversation not found', 404);
        }
        $stmt = $db->prepare("SELECT id, role, content, tool_calls, created_at FROM one_messages WHERE conversation_id=:cid ORDER BY id ASC LIMIT 100");
        $stmt->bindValue(':cid', $conversationId);
        $result = $stmt->execute();
        $messages = [];
        while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
            $messages[] = $row;
        }
        $db->close();
        jsonResponse(true, ['messages' => $messages]);
    } else {
        // List conversations
        $stmt = $db->prepare("SELECT id, title, updated_at FROM one_conversations WHERE user_email=:email ORDER BY updated_at DESC LIMIT 30");
        $stmt->bindValue(':email', $auth['email']);
        $result = $stmt->execute();
        $convos = [];
        while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
            $convos[] = $row;
        }
        $db->close();
        jsonResponse(true, ['conversations' => $convos]);
    }
}

// ─── Route Actions ───
// $action comes from email.php's scope (GET or POST body)
$oneAction = $action ?? ($_GET['action'] ?? ($_POST['action'] ?? ''));
try {
    switch ($oneAction) {
        case 'one_chat':
            $auth = requireAuth();
            // Only Plus/Family users can use One AI
            require_once __DIR__ . '/chat.php';
            require_once __DIR__ . '/plans.php';
            $chatDb = getChatDB();
            initPlansDB($chatDb);
            $userPlan = getUserPlan($auth['email']);
            $planName = $userPlan['plan'] ?? 'free';
            if ($planName === 'free') {
                // Allow 3 free messages per day for plan questions
                $rateKey = 'one_free_' . md5($auth['email']) . '_' . date('Y-m-d');
                $rateFile = '/tmp/' . $rateKey;
                $count = file_exists($rateFile) ? (int)file_get_contents($rateFile) : 0;

                if ($count >= 3) {
                    // Exceeded free limit
                    jsonResponse(true, [
                        'response' => "Você atingiu o limite de mensagens gratuitas por hoje. 😊\n\nAssine o **Chatyy One** por apenas **R\$12,99/mês** para conversar comigo sem limites!\n\n[Assinar agora →](/plans)",
                        'is_premium_prompt' => true,
                    ]);
                    break;
                }

                // Increment counter
                file_put_contents($rateFile, $count + 1, LOCK_EX);

                // Process with limited system prompt (plan info only, no action tools)
                handleOneChatFree($auth);
                break;
            }
            handleOneChat($auth);
            break;
        case 'one_history':
            $auth = requireAuth();
            handleOneHistory($auth);
            break;
        case 'one_tts':
            $auth = requireAuth();
            $input = getInput();
            $text = trim($input['text'] ?? ($_GET['text'] ?? ''));
            if (!$text) { jsonResponse(false, null, 'text required'); }
            $audio = oneTextToSpeech($text);
            if (!$audio) { jsonResponse(false, null, 'TTS failed'); }
            header('Content-Type: audio/mpeg');
            header('Content-Length: ' . strlen($audio));
            echo $audio;
            exit;
        case 'one_status':
            $auth = requireAuth();
            // Check plan for full features
            $isPaid = false;
            try {
                require_once __DIR__ . '/chat.php';
                require_once __DIR__ . '/plans.php';
                $chatDb = getChatDB();
                initPlansDB($chatDb);
                $p = getUserPlan($auth['email']);
                $isPaid = ($p['plan'] ?? 'free') !== 'free';
            } catch (Exception $e) {}
            jsonResponse(true, ['active' => true, 'name' => 'One', 'premium' => $isPaid]);
            break;
        default:
            jsonResponse(false, null, 'Unknown action', 400);
    }
} catch (Throwable $e) {
    error_log("[One] Error: " . $e->getMessage() . " in " . $e->getFile() . ":" . $e->getLine());
    jsonResponse(false, null, 'Erro interno', 500);
}
