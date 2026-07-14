class Spinner {
    private readonly frames = [
        '⠋',
        '⠙',
        '⠹',
        '⠸',
        '⠼',
        '⠴',
        '⠦',
        '⠧',
        '⠇',
        '⠏'
    ];

    private timer: NodeJS.Timeout | undefined;

    private index = 0;

    constructor(
        private message = 'Thinking...'
    ) { }

    start(): void {

        if (this.timer) {
            return;
        }

        this.timer = setInterval(() => {

            process.stdout.write(
                `\r${this.frames[this.index++ % this.frames.length]} ${this.message}`
            );

        }, 80);
    }

    stop(): void {

        if (!this.timer) {
            return;
        }

        clearInterval(this.timer);

        this.timer = undefined;

        process.stdout.write('\r\x1b[K');
    }

    update(message: string): void {

        this.message = message;
    }

    log(message: string): void {

        if (this.timer) {
            process.stdout.write('\r\x1b[K');
        }

        process.stdout.write(`${message}\n`);
    }
}

module.exports = {
    Spinner
};
