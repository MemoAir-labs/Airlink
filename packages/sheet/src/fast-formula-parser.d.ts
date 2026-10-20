declare module "fast-formula-parser" {
  type Position = { row: number; col: number; sheet?: string };
  type CellRef = { sheet?: string; row: number; col: number };
  type RangeRef = {
    sheet?: string;
    from: { row: number; col: number };
    to: { row: number; col: number };
  };

  class FormulaError extends Error {
    constructor(error: string, msg?: string);
    readonly error: string;
  }

  class DepParser {
    parse(
      input: string,
      position: Position,
      ignoreError?: boolean
    ): (CellRef | RangeRef)[];
  }

  class FormulaParser {
    constructor(config: {
      onCell: (ref: CellRef) => unknown;
      onRange: (ref: RangeRef) => unknown[][];
    });
    parse(input: string, position: Position): unknown;
    static FormulaError: typeof FormulaError;
    static DepParser: typeof DepParser;
  }

  export default FormulaParser;
}
