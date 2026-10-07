<?php
// This adapter runs Cypht's unmodified mail modules over private process pipes.
// It is deliberately independent of Cypht's HTTP/session/UI framework.
declare(strict_types=1);
error_reporting(E_ALL & ~E_DEPRECATED);
ini_set('display_errors', '0');
ini_set('log_errors', '0');
ini_set('default_socket_timeout', '12');
mb_internal_encoding('8bit');

class Hm_Debug { public static function add(...$ignored) {} }
class Hm_Msgs { public static function add(...$ignored) {} }
class Hm_Functions {
    public static function stream_socket_client($server, $port, &$errno, &$errstr, $timeout, $mode, $ctx) {
        if (!str_starts_with($server, 'tls://')) throw new RuntimeException('tls-required');
        // Upstream exposes a transport hook. Force authenticated TLS here for both
        // IMAP and SMTP, including upstream versions with permissive defaults.
        stream_context_set_option($ctx, 'ssl', 'verify_peer', true);
        stream_context_set_option($ctx, 'ssl', 'verify_peer_name', true);
        stream_context_set_option($ctx, 'ssl', 'allow_self_signed', false);
        stream_context_set_option($ctx, 'ssl', 'crypto_method', STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT);
        $stream = @stream_socket_client($server.':'.$port, $errno, $errstr, min(12, $timeout), $mode, $ctx);
        if (is_resource($stream)) stream_set_timeout($stream, 12);
        return $stream;
    }
    public static function stream_ended($stream) { return !is_resource($stream) || feof($stream) || stream_get_meta_data($stream)['timed_out']; }
    public static function stream_socket_enable_crypto($stream, $type) { throw new RuntimeException('tls-required'); }
}
function get_tls_stream_type() { return STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT; }
function hm_exists($name) { return function_exists($name); }
$base = dirname(__DIR__).'/vendor/cypht/';
foreach (['lib/repository.php', 'lib/searchable.php', 'lib/servers.php', 'lib/scram.php', 'modules/imap/hm-imap.php', 'modules/smtp/hm-smtp.php'] as $file) require_once $base.$file;

function text($value, int $limit = 1000): string {
    $value = (string)$value;
    return mb_substr(mb_convert_encoding($value, 'UTF-8', 'UTF-8'), 0, $limit, 'UTF-8');
}
function header_text($value): string { return text(iconv_mime_decode((string)$value, ICONV_MIME_DECODE_CONTINUE_ON_ERROR, 'UTF-8') ?: $value); }
// The IMAP bodystructure parser calls this framework hook for MIME fields.
function decode_fld($value): string { return header_text($value); }
function message(Hm_IMAP $imap, array $account, array $row): array {
    return ['accountId' => $account['id'], 'uid' => (int)$row['uid'], 'validity' => (int)$imap->selected_mailbox['detail']['uidvalidity'],
        'subject' => header_text($row['subject']), 'from' => header_text($row['from']), 'to' => header_text($row['to']),
        'date' => (int)(strtotime($row['internal_date'] ?: $row['date']) ?: 0), 'size' => (int)$row['size'],
        'read' => str_contains($row['flags'], '\\Seen'), 'starred' => str_contains($row['flags'], '\\Flagged'), 'messageId' => text($row['message_id'])];
}
function connection(array $account): Hm_IMAP {
    $imap = new Hm_IMAP();
    $imap->verify_peer = $imap->verify_peer_name = true;
    if (!$imap->connect(['server' => $account['imapHost'], 'port' => $account['imapPort'], 'tls' => true, 'username' => $account['username'], 'password' => $account['password'], 'auth' => 'login', 'use_cache' => false, 'max_history' => 0, 'app_name' => 'MyWallpaper Mail', 'app_vendor' => 'MyWallpaper'])) throw new RuntimeException('account-unavailable');
    if (!$imap->select_mailbox('INBOX')) throw new RuntimeException('mailbox-unavailable');
    return $imap;
}
function handle(array $command): array {
    $account = $command['account']; $input = $command['input'] ?? []; $action = $command['action'];
    if ($action === 'send') {
        if (empty($account['smtpHost'])) throw new RuntimeException('smtp-not-configured');
        $smtp = new Hm_SMTP(['server' => $account['smtpHost'], 'port' => $account['smtpPort'], 'tls' => true, 'username' => $account['username'], 'password' => $account['password']]);
        if ($smtp->connect() !== false || $smtp->state !== 'authed') throw new RuntimeException('smtp-unavailable');
        try {
            $to = $input['to']; $subject = base64_encode($input['subject']);
            $domain = substr(strrchr($account['email'], '@'), 1);
            $mail = 'From: '.$account['email']."\r\nTo: ".implode(', ', $to)."\r\nSubject: =?UTF-8?B?".$subject."?=\r\nDate: ".gmdate('r')."\r\nMessage-ID: <".bin2hex(random_bytes(16)).'@'.$domain.">\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n";
            if (!empty($input['inReplyTo']) && preg_match('/^<[^\r\n<>]{1,800}>$/D', $input['inReplyTo'])) $mail .= 'In-Reply-To: '.$input['inReplyTo']."\r\nReferences: ".$input['inReplyTo']."\r\n";
            $mail .= "\r\n".chunk_split(base64_encode($input['body']), 76, "\r\n");
            if ($smtp->send_message($account['email'], $to, $mail) !== false) throw new RuntimeException('send-unconfirmed');
            return ['sent' => true];
        } finally { $smtp->disconnect(); }
    }
    $imap = connection($account);
    try {
        $validity = (int)$imap->selected_mailbox['detail']['uidvalidity'];
        if (isset($input['validity']) && $input['validity'] !== $validity) throw new RuntimeException('mailbox-changed');
        if ($action === 'check') return ['ready' => true];
        if ($action === 'list') {
            $upper = min((int)$imap->selected_mailbox['detail']['uidnext'] - 1, (int)($input['before'] ?? PHP_INT_MAX));
            $uids = []; $cursor = $upper;
            $filter = match ($input['filter'] ?? 'all') { 'unread' => 'UNSEEN', 'starred' => 'FLAGGED', default => 'ALL' };
            // Bounded UID windows avoid Cypht's full-folder sort/FETCH fallback.
            for ($i = 0; $i < 6 && $cursor > 0 && count($uids) < 20; $i++) {
                $lower = max(1, $cursor - 255);
                // Cypht restores the requested UID order by iterating this value.
                // Supply the bounded array its public API expects, not a range string.
                $batch = $imap->search($filter, range($lower, $cursor));
                foreach ($batch ?: [] as $uid) if ((int)$uid <= $upper && (int)$uid >= $lower) $uids[] = (int)$uid;
                $cursor = $lower - 1;
            }
            rsort($uids, SORT_NUMERIC); $uids = array_slice(array_unique($uids), 0, 20);
            $rows = $uids ? $imap->get_message_list($uids, true, false, false, false) : [];
            return ['messages' => array_values(array_map(fn($row) => message($imap, $account, $row), $rows)), 'cursor' => $uids ? min($uids) - 1 : $cursor];
        }
        $uid = $input['uid'];
        $rows = $imap->get_message_list([$uid], true, false, false, false);
        if (!isset($rows[$uid])) throw new RuntimeException('message-missing');
        if ($action === 'flag') {
            if (empty($imap->message_action($input['flag'] ? 'FLAG' : 'UNFLAG', [$uid])['status'])) throw new RuntimeException('request-failed');
            return ['starred' => $input['flag']];
        }
        $structure = $imap->get_message_structure($uid);
        if ($action === 'attachment') {
            $parts = $imap->search_bodystructure($structure, ['imap_part_number' => $input['part']], true);
            $part = $parts[$input['part']] ?? null;
            if (!$part || (int)($part['size'] ?? 0) > 2 * 1024 * 1024) throw new RuntimeException('attachment-too-large');
            $bytes = $imap->get_message_content($uid, $input['part'], 2 * 1024 * 1024, $part);
            return ['bytes' => base64_encode($bytes), 'type' => 'application/octet-stream'];
        }
        $parts = $imap->search_bodystructure($structure, ['type' => 'text', 'subtype' => 'plain'], true);
        $html = false;
        if (!$parts) { $parts = $imap->search_bodystructure($structure, ['type' => 'text', 'subtype' => 'html'], true); $html = true; }
        $body = ''; $truncated = false;
        foreach ($parts as $number => $part) {
            if (($part['disposition'] ?? '') === 'attachment') continue;
            if ((int)($part['size'] ?? 0) > 256 * 1024) { $truncated = true; continue; }
            $body = $imap->get_message_content($uid, $number, 256 * 1024, $part); break;
        }
        if ($html) {
            $body = preg_replace('/<(script|style)\b[^>]*>.*?<\/\1>/is', '', $body);
            $body = preg_replace('/<(?:br\b[^>]*|\/p|\/div|\/li)>/i', "\n", $body);
            $body = html_entity_decode(strip_tags($body), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        }
        $attachments = [];
        foreach ($imap->search_bodystructure($structure, [], true) as $number => $part) {
            $name = $part['file_attributes']['filename'] ?? $part['attributes']['name'] ?? null;
            if ($name) $attachments[] = ['part' => (string)$number, 'name' => header_text($name), 'size' => (int)($part['size'] ?? 0), 'type' => ($part['type'] ?? 'application').'/'.($part['subtype'] ?? 'octet-stream')];
        }
        $marked = $imap->message_action('READ', [$uid]);
        $row = message($imap, $account, $rows[$uid]); $row['read'] = $row['read'] || !empty($marked['status']);
        return ['message' => $row, 'body' => text(trim($body), 256 * 1024), 'attachments' => array_slice($attachments, 0, 30), 'truncated' => $truncated];
    } finally { $imap->disconnect(); }
}
while (($line = fgets(STDIN, 1024 * 1024)) !== false) {
    try {
        $request = json_decode($line, true, 32, JSON_THROW_ON_ERROR);
        ob_start();
        try { $result = handle($request); } finally { ob_end_clean(); }
        $response = ['ok' => true, 'result' => $result];
    } catch (Throwable $error) {
        $known = ['account-unavailable', 'mailbox-unavailable', 'smtp-not-configured', 'smtp-unavailable', 'send-unconfirmed', 'mailbox-changed', 'message-missing', 'request-failed', 'attachment-too-large', 'tls-required'];
        $response = ['ok' => false, 'error' => in_array($error->getMessage(), $known, true) ? $error->getMessage() : 'engine-error'];
    }
    echo json_encode($response, JSON_INVALID_UTF8_SUBSTITUTE | JSON_UNESCAPED_UNICODE)."\n";
    flush();
}
