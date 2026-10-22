export class Mutex {
  constructor() {
    this.locked = false;
    this.queue = [];
  }

  async lock() {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    await new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  unlock() {
    const next = this.queue.shift();

    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}