class Queue {
	constructor(options = {}) {
		this.concurrency = options.concurrency || 1;
		this.taskTimeout = options.taskTimeout ?? 20000; // 20s padrão conforme solicitado
		this.pending = 0;
		this.queue = [];
		this.processing = {}; // { priority: count }
		this.fulfilled = {}; // { priority: count }
		this.failed = {}; // { priority: count }
	}

	add(fn, options = {}) {
		return new Promise((resolve, reject) => {
			const element = {
				fn,
				priority: options.priority || 0,
				timeout: options.timeout ?? this.taskTimeout,
				resolve,
				reject,
				timestamp: Date.now()
			};
			this._insertSorted(element);
			this._process();
		});
	}

	addAt(fn, index, options = {}) {
		return new Promise((resolve, reject) => {
			const element = {
				fn,
				priority: options.priority || 0,
				timeout: options.timeout ?? this.taskTimeout,
				resolve,
				reject,
				timestamp: Date.now()
			};
			if (index < 0) index = 0;
			if (index >= this.queue.length) {
				this.queue.push(element);
			} else {
				this.queue.splice(index, 0, element);
			}
			this._process();
		});
	}

	_insertSorted(element) {
		let added = false;
		for (let i = 0; i < this.queue.length; i++) {
			const item = this.queue[i];
			// Higher priority first
			if (element.priority > item.priority) {
				this.queue.splice(i, 0, element);
				added = true;
				break;
			}
			// Same priority, older timestamp first (FIFO)
			else if (element.priority === item.priority && element.timestamp < item.timestamp) {
				this.queue.splice(i, 0, element);
				added = true;
				break;
			}
		}
		if (!added) {
			this.queue.push(element);
		}
	}

	_process() {
		if (this.pending >= this.concurrency || this.queue.length === 0) {
			return;
		}

		this.pending++;
		const item = this.queue.shift();
		const p = item.priority.toString();
		this.processing[p] = (this.processing[p] || 0) + 1;

		let isSettled = false;
		let timer = null;

		const cleanup = () => {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			this.pending = Math.max(0, this.pending - 1);
			this.processing[p] = Math.max(0, (this.processing[p] || 0) - 1);
			this._process();
		};

		const itemTimeout = item.timeout !== undefined ? item.timeout : this.taskTimeout;
		if (itemTimeout > 0) {
			timer = setTimeout(() => {
				if (!isSettled) {
					isSettled = true;
					this.failed[p] = (this.failed[p] || 0) + 1;
					const timeoutErr = new Error(
						`[Queue] Task timed out after ${itemTimeout}ms (Priority ${p})`
					);
					timeoutErr.isTimeout = true;
					item.reject(timeoutErr);
					cleanup();
				}
			}, itemTimeout);
		}

		// Execute
		Promise.resolve()
			.then(() => item.fn())
			.then((result) => {
				if (!isSettled) {
					isSettled = true;
					this.fulfilled[p] = (this.fulfilled[p] || 0) + 1;
					item.resolve(result);
					cleanup();
				}
			})
			.catch((err) => {
				if (!isSettled) {
					isSettled = true;
					this.failed[p] = (this.failed[p] || 0) + 1;
					item.reject(err);
					cleanup();
				}
			});
	}

	clear(reason = "Queue cleared") {
		const err = new Error(reason);
		err.noRetry = true;
		let count = 0;
		while (this.queue.length > 0) {
			const item = this.queue.shift();
			const p = item.priority.toString();
			this.failed[p] = (this.failed[p] || 0) + 1;
			try {
				item.reject(err);
			} catch (_) {}
			count++;
		}
		return count;
	}

	reset() {
		this.pending = 0;
		this.processing = {};
		this._process();
	}

	getStats() {
		const stats = {};

		// Collect all priorities from all states to ensure we return a complete object
		const allPriorities = new Set([
			...this.queue.map((i) => i.priority.toString()),
			...Object.keys(this.processing),
			...Object.keys(this.fulfilled)
		]);

		allPriorities.forEach((p) => {
			stats[p] = {
				pending: this.queue.filter((i) => i.priority.toString() === p).length,
				processing: this.processing[p] || 0,
				fulfilled: this.fulfilled[p] || 0,
				failed: this.failed[p] || 0
			};
		});

		return stats;
	}

	get size() {
		return this.queue.length;
	}

	get isPaused() {
		return false; // Not implemented
	}
}

module.exports = Queue;
