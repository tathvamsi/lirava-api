export type ServerEvent = {
  type: string;
  dotId?: string;
  userId?: string;
  id?: string;
  delta?: string;
  data?: any;
};

type Listener = (event: ServerEvent) => void;

class EventBus {
  private listeners: Set<Listener> = new Set();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[event-bus] Error notifying listener:", err);
      }
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

export const eventBus = new EventBus();
export const emit = (event: ServerEvent) => eventBus.emit(event);
export const onEvent = (listener: Listener) => eventBus.subscribe(listener);
