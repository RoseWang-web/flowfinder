import '@testing-library/react'

// Minimal localStorage mock for jsdom
const store: Record<string, string> = {}
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value },
  removeItem: (key: string) => { delete store[key] },
  clear: () => { Object.keys(store).forEach(k => delete store[k]) },
}
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock })

beforeEach(() => localStorageMock.clear())
