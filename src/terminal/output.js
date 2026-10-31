const ANSI = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m'
};

function paint(text, color, enabled) {
    return enabled && ANSI[color] ? `${ANSI[color]}${text}${ANSI.reset}` : text;
};

class OutputSanitizer {
    constructor() {
        this.state = 'normal';
    };

    write(chunk) {
        const text = String(chunk);
        let out = '';
        let i = 0;

        while (i < text.length) {
            const ch = text[i];
            if (this.state === 'normal') {
                if (ch === '\x1b') {
                    this.state = 'escape';
                    i += 1;
                } else if (ch === '\r') {
                    i += 1;
                } else if (ch === '\n' || ch === '\t') {
                    out += ch;
                    i += 1;
                } else if (ch < ' ' || ch === '\x7f') {
                    i += 1;
                } else if (ch >= '\x80' && ch <= '\x9f') {
                    i += 1;
                } else {
                    out += ch;
                    i += 1;
                };
            } else if (this.state === 'escape') {
                if (ch === '[') {
                    this.state = 'csi';
                } else if (ch === ']') {
                    this.state = 'osc';
                } else if (ch === 'P' || ch === '^' || ch === '_') {
                    this.state = 'string';
                } else {
                    this.state = 'normal';
                };

                i += 1;
            } else if (this.state === 'csi') {
                if (ch >= '@' && ch <= '~') this.state = 'normal';
                i += 1;
            } else if (this.state === 'osc') {
                if (ch === '\x07') {
                    this.state = 'normal';
                } else if (ch === '\x1b') {
                    this.state = 'osc-escape';
                };

                i += 1;
            } else if (this.state === 'osc-escape') {
                this.state = ch === '\\' ? 'normal' : 'osc';
                i += 1;
            } else if (this.state === 'string') {
                if (ch === '\x1b') this.state = 'string-escape';
                i += 1;
            } else if (this.state === 'string-escape') {
                this.state = ch === '\\' ? 'normal' : 'string';
                i += 1;
            };
        };

        return out;
    };
};

function statusLabel(status) {
    if (status === 'PROCESSING') {
        return 'RUNNING';
    };

    if (status === 'PENDING') {
        return 'QUEUED';
    };

    return status || 'UNKNOWN';
};

function statusRank(status) {
    if (status === 'PENDING') {
        return 0;
    };

    if (status === 'PROCESSING') {
        return 1;
    };

    if (status === 'COMPLETED' || status === 'FAILED') {
        return 2;
    };

    return -1;
};

function statusColor(status) {
    if (status === 'COMPLETED') {
        return 'green';
    };

    if (status === 'FAILED') {
        return 'red';
    };

    if (status === 'PROCESSING') {
        return 'yellow';
    };

    return 'cyan';
};

function wrapLine(line, width) {
    if (!width || line.length <= width) {
        return [line];
    };

    const parts = [];
    let rest = line;

    while (rest.length > width) {
        let cut = rest.lastIndexOf(' ', width);
        if (cut < Math.floor(width / 2)) {
            cut = width;
        };

        parts.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^ +/, '');
    };

    parts.push(rest);

    return parts;
};

function terminalWidth() {
    return Math.max(40, process.stdout.columns || 120);
};

module.exports = {
    ANSI,
    OutputSanitizer,
    paint,
    statusColor,
    statusLabel,
    statusRank,
    terminalWidth,
    wrapLine
};