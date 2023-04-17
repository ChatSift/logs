export class LazyIter<T, TRaw = T> {
	#done = false;

	#reading = true;

	private readonly buffer: T[] = [];

	private readonly peekWaitingPromises: { resolve(): void }[] = [];

	private readonly nextWaitingPromises: { reject(reason: Error): void; resolve(): void }[] = [];

	public get done(): boolean {
		return this.#done && this.buffer.length === 0;
	}

	public get reading(): boolean {
		return this.#reading;
	}

	public constructor(
		private readonly iter: AsyncIterableIterator<TRaw>,
		private readonly transformValue?: (raw: TRaw) => T | T[],
	) {
		void this.loop();
	}

	public pause(): void {
		this.#reading = false;
	}

	public resume(): boolean {
		if (this.#done) {
			return false;
		}

		this.#reading = true;
		void this.loop();

		return true;
	}

	public async peek(): Promise<T | undefined> {
		// If we're done for good, there's nothing to peek
		if (this.done) {
			return;
		}

		// If our buffer is empty but we're not done, we just wait for the next element
		if (this.buffer.length === 0) {
			await new Promise<void>((resolve) => {
				this.peekWaitingPromises.push({ resolve });
			});
		}

		return this.buffer[0];
	}

	public async peekAnd(is: (item: T) => boolean): Promise<T | undefined> {
		const peeked = await this.peek();
		if (peeked === undefined) {
			return;
		}

		return is(peeked) ? peeked : undefined;
	}

	public async next(): Promise<T> {
		// If we're done for good, there's nothing to return
		if (this.done) {
			throw new Error('No more items to consume');
		}

		// If our buffer is empty but we're not done, we just wait for the next element
		if (this.buffer.length === 0) {
			await new Promise<void>((resolve, reject) => {
				this.nextWaitingPromises.push({ resolve, reject });
			});
		}

		return this.buffer.shift()!;
	}

	private async loop(): Promise<void> {
		while (this.#reading) {
			const { value, done } = await this.iter.next();

			if (value) {
				const transformed = this.transformValue?.(value) ?? (value as unknown as T);
				const transformedArray = Array.isArray(transformed) ? transformed : [transformed];

				for (const item of transformedArray) {
					this.buffer.push(item);

					const peekPromise = this.peekWaitingPromises.shift();
					peekPromise?.resolve();

					const nextPromise = this.nextWaitingPromises.shift();
					nextPromise?.resolve();
				}
			}

			if (done) {
				this.#done = true;
				this.#reading = false;

				for (const peekPromise of this.peekWaitingPromises.splice(0, this.peekWaitingPromises.length)) {
					peekPromise.resolve();
				}

				for (const nextPromise of this.nextWaitingPromises.splice(0, this.nextWaitingPromises.length)) {
					nextPromise.reject(new Error('No more items to consume'));
				}
			}
		}
	}
}
