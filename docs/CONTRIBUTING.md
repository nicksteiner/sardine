# Contributing to SARdine

Thank you for your interest in contributing to SARdine!

## Development Setup

1. Clone the repository:
```bash
git clone https://github.com/nicksteiner/sardine.git
cd sardine
```

2. Install dependencies:
```bash
npm install
```

3. Build the library:
```bash
npm run build
```

4. Run tests:
```bash
npm test
```

## Project Structure

```
sardine/
├── src/
│   ├── SARdine.ts              # Main viewer class
│   ├── index.ts                # Public API exports
│   ├── layers/
│   │   └── SARImageLayer.ts    # Custom deck.gl layer for SAR imagery
│   ├── types/
│   │   └── index.ts            # TypeScript type definitions
│   └── utils/
│       └── geotiff.ts          # GeoTIFF utilities
├── examples/
│   ├── basic.html              # HTML example
│   └── usage.ts                # TypeScript usage examples
├── dist/                       # Build output (generated)
└── README.md
```

## Development Workflow

1. **Make changes** to the source code in the `src/` directory
2. **Build** using `npm run build` to compile TypeScript
3. **Test** using `npm test` to ensure nothing breaks
4. **Create a PR** with a clear description of your changes

## Coding Standards

- Use TypeScript for all source code
- Follow existing code style and conventions
- Add JSDoc comments for public APIs
- Write tests for new functionality
- Keep dependencies minimal

## Testing

We use Jest for testing. Tests are located alongside the source files with `.test.ts` extension.

```bash
npm test                    # Run all tests
npm test -- --watch         # Run tests in watch mode
```

## Building

```bash
npm run build              # Build once
npm run dev                # Build in watch mode
```

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Questions?

Feel free to open an issue for any questions or concerns.
