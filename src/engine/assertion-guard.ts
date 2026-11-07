import path from 'node:path';

export interface AssertionViolation {
  file: string;
  type: 'deleted_assertion' | 'deleted_test_case' | 'trivialized_assertion';
  message: string;
  details: string[];
}

export interface AssertionValidationResult {
  allowed: boolean;
  reason?: string;
  violation?: AssertionViolation;
}

interface AssertionMatch {
  line: number;
  start: number;
  end: number;
  text: string;
  kind: string;
}

/**
 * TestAssertionGuard enforces test integrity across multiple languages (JS/TS, Python, Rust, Go).
 * 
 * Invariant Guarantee:
 * The AI agent is strictly prohibited from deleting, commenting out, or trivializing test assertions
 * or test blocks to make tests pass. The agent MUST fix the underlying implementation code instead.
 */
export class TestAssertionGuard {
  private static readonly TEST_PATH_PATTERNS: RegExp[] = [
    /(?:^|[\\/])(?:tests?|__tests__|specs?)[\\/]/i,
    /\.(?:test|spec)\.[a-zA-Z0-9]+$/i,
    /(?:^|[\\/])test_[^\\/]+\.py$/i,
    /(?:^|[\\/])[^\\/]+_test\.(?:py|go|rs)$/i,
    /(?:^|[\\/])tests?\.(?:rs|py|go|js|ts)$/i,
  ];

  // Language-specific or universal assertion patterns
  private static readonly ASSERTION_PATTERNS: Array<{ kind: string; regex: RegExp; ext?: RegExp }> = [
    // JS/TS: assert.equal, assert.strictEqual, assert.ok, assert.deepEqual, assert(x)
    { kind: 'js_assert', regex: /\bassert(?:\.[a-zA-Z0-9_$]+)?\s*\(/g, ext: /\.(?:[cm]?[jt]sx?)$/i },
    // JS/TS: expect(x).toBe(y), expect(x).toEqual(y), expect(...)
    { kind: 'js_expect', regex: /\bexpect\s*\([^;{}]*\)(?:\s*\.[a-zA-Z0-9_$]+)?/g, ext: /\.(?:[cm]?[jt]sx?)$/i },
    // JS/TS: should.exist, should.equal
    { kind: 'js_should', regex: /\bshould(?:\.[a-zA-Z0-9_$]+)+\b/g, ext: /\.(?:[cm]?[jt]sx?)$/i },
    // Python: assert condition
    { kind: 'py_assert', regex: /^[ \t]*assert\b[^\n]+/gm, ext: /\.py$/i },
    // Python unittest: self.assertEqual, self.assertTrue, etc.
    { kind: 'py_unittest', regex: /\bself\.assert[a-zA-Z0-9_]+\s*\(/g, ext: /\.py$/i },
    // Python pytest: pytest.raises, pytest.approx
    { kind: 'py_pytest', regex: /\bpytest\.(?:raises|warns|approx)\s*\(/g, ext: /\.py$/i },
    // Rust: assert!, assert_eq!, assert_ne!, debug_assert!
    { kind: 'rust_assert', regex: /\b(?:debug_)?assert(?:_eq|_ne)?!\s*\(/g, ext: /\.rs$/i },
    // Go: assert.Equal, require.NoError
    { kind: 'go_testify', regex: /\b(?:assert|require)\.[a-zA-Z0-9_]+\s*\(/g, ext: /\.go$/i },
    // Go: t.Errorf, t.Fatalf
    { kind: 'go_testing_t', regex: /\bt\.(?:Error|Fatal|Fail)[a-zA-Z0-9_]*\s*\(/g, ext: /\.go$/i },
    // Generic fallback for unknown test extensions:
    { kind: 'generic_assert', regex: /\b(?:assert|expect|assert_eq|self\.assert)\b/g }
  ];

  private static readonly TEST_BLOCK_PATTERNS: Array<{ kind: string; regex: RegExp }> = [
    // JS/TS: test('...', ...), it('...', ...), describe('...', ...)
    { kind: 'js_test', regex: /\b(?:test|it|describe)(?:\.(?:only|skip|todo|concurrent))?\s*\(\s*(['"`][^'"`]+['"`])/g },
    // Python: def test_...
    { kind: 'py_test', regex: /^[ \t]*def\s+(test_[a-zA-Z0-9_]+)\s*\(/gm },
    // Rust: fn test_... or #[test]
    { kind: 'rust_test', regex: /^[ \t]*(?:async\s+)?fn\s+([a-zA-Z0-9_]+_test|test_[a-zA-Z0-9_]+)\s*\(/gm },
    // Go: func Test...
    { kind: 'go_test', regex: /\bfunc\s+(Test[a-zA-Z0-9_]+)\s*\(/g }
  ];

  private static readonly DUMMY_ASSERTION_PATTERNS: RegExp[] = [
    /\bassert(?:\.ok)?\s*\(\s*true\s*[,)]/i,
    /\bassert\s*\(\s*1\s*===?\s*1\s*[,)]/i,
    /\bexpect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/i,
    /\bexpect\s*\(\s*true\s*\)\s*\.toBeTruthy\s*\(\s*\)/i,
    /^[ \t]*assert\s+True\b/m,
    /\bassert_eq!\s*\(\s*true\s*,\s*true\s*\)/i,
    /\bassert_eq!\s*\(\s*1\s*,\s*1\s*\)/i
  ];

  /**
   * Checks whether a file path qualifies as a test file.
   */
  static isTestFile(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    return this.TEST_PATH_PATTERNS.some(pattern => pattern.test(normalized));
  }

  /**
   * Strips comments from code while preserving newline structure.
   * This ensures commented-out assertions (e.g. `// assert.equal(...)`) are treated as absent/deleted.
   */
  static stripComments(code: string): string {
    return code
      // Block comments: /* ... */ -> preserve line count
      .replace(/\/\*[\s\S]*?\*\//g, match => '\n'.repeat(match.split('\n').length - 1))
      // Python multi-line docstrings: """ ... """ or ''' ... '''
      .replace(/"""[\s\S]*?"""/g, match => '\n'.repeat(match.split('\n').length - 1))
      .replace(/'''[\s\S]*?'''/g, match => '\n'.repeat(match.split('\n').length - 1))
      // Single-line JS/Rust/Go comments: // ...
      .replace(/\/\/[^\n]*/g, '')
      // Single-line Python comments: # ... (avoid matching #include or CSS hex colors)
      .replace(/^[ \t]*#[^\n]*/gm, '')
      .replace(/\s+#[^\n]*/g, '');
  }

  /**
   * Discovers all non-overlapping assertion occurrences in the code.
   */
  private static findAssertionSpans(code: string, filePath?: string): AssertionMatch[] {
    const cleanCode = this.stripComments(code);
    const matches: AssertionMatch[] = [];
    const ext = filePath ? path.extname(filePath).toLowerCase() : '';

    // Filter relevant patterns for this file extension (or use all if unknown)
    const activePatterns = this.ASSERTION_PATTERNS.filter(p => !p.ext || !ext || p.ext.test(filePath!));

    for (const { kind, regex } of activePatterns) {
      const re = new RegExp(regex.source, regex.flags);
      let match: RegExpExecArray | null;
      while ((match = re.exec(cleanCode)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        const text = match[0].trim();

        // Calculate line number
        const line = cleanCode.substring(0, start).split('\n').length;

        // Ensure this span doesn't overlap with an already recorded assertion
        const overlaps = matches.some(m => Math.max(start, m.start) < Math.min(end, m.end));
        if (!overlaps) {
          matches.push({ line, start, end, text, kind });
        }
      }
    }

    // Sort by source appearance
    matches.sort((a, b) => a.start - b.start);
    return matches;
  }

  /**
   * Extracts active assertion statements from source code (comments ignored).
   */
  static extractAssertions(code: string, filePath?: string): string[] {
    const spans = this.findAssertionSpans(code, filePath);
    return spans.map(s => s.text);
  }

  /**
   * Counts total active assertions in source code.
   */
  static countAssertions(code: string, filePath?: string): number {
    return this.findAssertionSpans(code, filePath).length;
  }

  /**
   * Extracts test case names / identifiers from source code.
   */
  static extractTestNames(code: string): string[] {
    const cleanCode = this.stripComments(code);
    const names: string[] = [];

    for (const { regex } of this.TEST_BLOCK_PATTERNS) {
      const re = new RegExp(regex.source, regex.flags);
      let match: RegExpExecArray | null;
      while ((match = re.exec(cleanCode)) !== null) {
        const testName = match[1]?.trim() || match[0].trim();
        if (testName && !names.includes(testName)) {
          names.push(testName);
        }
      }
    }

    return names;
  }

  /**
   * Checks whether the code contains known dummy/tautological assertions.
   */
  static hasTrivialDummyAssertions(code: string): boolean {
    const cleanCode = this.stripComments(code);
    return this.DUMMY_ASSERTION_PATTERNS.some(pattern => pattern.test(cleanCode));
  }

  /**
   * Validates an edit to ensure test assertions and test cases are strictly preserved.
   * 
   * @param filePath Target file path being edited
   * @param oldContent Original file content before edit
   * @param newContent Proposed file content after edit
   * @param allowTestEdits Optional flag to permit test edits when explicitly authorized by user
   */
  static validateEdit(
    filePath: string,
    oldContent: string,
    newContent: string,
    allowTestEdits: boolean = false
  ): AssertionValidationResult {
    // 1. If explicit user authorization is provided, allow the edit
    if (allowTestEdits) {
      return { allowed: true };
    }

    // 2. If the file is not a test file, allow normal editing
    if (!this.isTestFile(filePath)) {
      return { allowed: true };
    }

    const oldAssertions = this.extractAssertions(oldContent, filePath);
    const newAssertions = this.extractAssertions(newContent, filePath);
    const oldCount = oldAssertions.length;
    const newCount = newAssertions.length;

    // 3. Invariant Check A: Total assertion count must NOT decrease
    if (newCount < oldCount) {
      const deletedAssertions = oldAssertions.filter(
        oldA => !newAssertions.some(newA => newA === oldA) && !newContent.includes(oldA)
      );

      const details = deletedAssertions.length > 0
        ? deletedAssertions
        : [`Assertion count decreased from ${oldCount} to ${newCount}`];

      return {
        allowed: false,
        violation: {
          file: filePath,
          type: 'deleted_assertion',
          message: `Blocked edit that deletes ${oldCount - newCount} test assertion(s).`,
          details
        },
        reason: this.formatViolationReport(filePath, 'deleted_assertion', oldCount, newCount, details)
      };
    }

    // 4. Invariant Check B: Existing test blocks must NOT be deleted
    const oldTests = this.extractTestNames(oldContent);
    const newTests = this.extractTestNames(newContent);
    if (newTests.length < oldTests.length) {
      const deletedTests = oldTests.filter(t => !newTests.includes(t));
      if (deletedTests.length > 0) {
        return {
          allowed: false,
          violation: {
            file: filePath,
            type: 'deleted_test_case',
            message: `Blocked edit that deletes test case(s): ${deletedTests.join(', ')}`,
            details: deletedTests
          },
          reason: this.formatViolationReport(filePath, 'deleted_test_case', oldTests.length, newTests.length, deletedTests)
        };
      }
    }

    // 5. Invariant Check C: Introduction of trivial dummy assertions to replace real logic
    // Only flag if the replacement introduced a dummy AND total assertions didn't genuinely expand
    const oldHasDummy = this.hasTrivialDummyAssertions(oldContent);
    const newHasDummy = this.hasTrivialDummyAssertions(newContent);
    if (!oldHasDummy && newHasDummy && newCount <= oldCount) {
      return {
        allowed: false,
        violation: {
          file: filePath,
          type: 'trivialized_assertion',
          message: 'Blocked edit that introduces a trivial/dummy assertion (e.g. assert.ok(true) or expect(true).toBe(true)).',
          details: ['Trivial dummy assertion introduced to evade test failure.']
        },
        reason: this.formatViolationReport(
          filePath,
          'trivialized_assertion',
          oldCount,
          newCount,
          ['Detected dummy assertion (e.g., assert.ok(true), assert True, expect(true).toBe(true)) inserted into test.']
        )
      };
    }

    return { allowed: true };
  }

  /**
   * Formats a clear, actionable diagnostic error report back to the LLM agent.
   */
  private static formatViolationReport(
    filePath: string,
    type: 'deleted_assertion' | 'deleted_test_case' | 'trivialized_assertion',
    beforeCount: number,
    afterCount: number,
    details: string[]
  ): string {
    const formattedDetails = details.slice(0, 5).map(d => `  - ${d}`).join('\n');
    return `[HARNESS INVARIANT VIOLATION: TEST ASSERTION TAMPERING BLOCKED]
File: "${filePath}"
Policy: Modifying, commenting out, or deleting assertions in test files is strictly prohibited.

Violation: ${type === 'deleted_assertion'
      ? `Assertion count reduced from ${beforeCount} to ${afterCount}.`
      : type === 'deleted_test_case'
      ? `Test case(s) removed from test suite (from ${beforeCount} to ${afterCount} tests).`
      : 'Trivial dummy assertion introduced to bypass test verification.'}

Affected Items:
${formattedDetails}

CORRECTIVE DIRECTIVE:
1. Do NOT delete, comment out, or weaken test assertions or test cases to make the test runner pass.
2. Re-read the original test contract and examine the production implementation instead.
3. Fix the underlying bug in the source code so that it genuinely satisfies all original test assertions.`;
  }
}
