export function greet(name: string): string {
    return `Hello, ${name || 'World'}!`;
}

export function welcome(name: string): string {
    return `Welcome, ${name || 'User'}!`;
}

export function farewell(name: string): string {
    return `Goodbye, ${name || 'Friend'}.`;
}