class EventBus {
    listeners = new Set();
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    emit(event) {
        for (const listener of this.listeners) {
            try {
                listener(event);
            }
            catch (err) {
                console.error("[event-bus] Error notifying listener:", err);
            }
        }
    }
    listenerCount() {
        return this.listeners.size;
    }
}
export const eventBus = new EventBus();
export const emit = (event) => eventBus.emit(event);
export const onEvent = (listener) => eventBus.subscribe(listener);
