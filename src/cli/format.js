import { promises as fs } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import prettier from "../index.js";
import { getStdin } from "../common/third-party.cjs";
import { createIgnorer, errors } from "./prettier-internal.js";
import { expandPatterns, fixWindowsSlashes } from "./expand-patterns.js";
import getOptionsForFile from "./options/get-options-for-file.js";
import isTTY from "./is-tty.js";

let createTwoFilesPatch;
async function diff(a, b) {
  if (!createTwoFilesPatch) {
    ({ createTwoFilesPatch } = await import("diff"));
  }

  return createTwoFilesPatch("", "", a, b, "", "", { context: 2 });
}

function handleError(context, filename, error, printedFilename) {
  if (error instanceof errors.UndefinedParserError) {
    // Can't test on CI, `isTTY()` is always false, see ./is-tty.js
    /* istanbul ignore next */
    if ((context.argv.write || context.argv.ignoreUnknown) && printedFilename) {
      printedFilename.clear();
    }
    if (context.argv.ignoreUnknown) {
      return;
    }
    if (!context.argv.check && !context.argv.listDifferent) {
      process.exitCode = 2;
    }
    context.logger.error(error.message);
    return;
  }

  if (context.argv.write) {
    // Add newline to split errors from filename line.
    process.stdout.write("\n");
  }

  const isParseError = Boolean(error && error.loc);
  const isValidationError = /^Invalid \S+ value\./.test(error && error.message);

  if (isParseError) {
    // `invalid.js: SyntaxError: Unexpected token (1:1)`.
    context.logger.error(`${filename}: ${String(error)}`);
  } else if (isValidationError || error instanceof errors.ConfigError) {
    // `Invalid printWidth value. Expected an integer, but received 0.5.`
    context.logger.error(error.message);
    // If validation fails for one file, it will fail for all of them.
    process.exit(1);
  } else if (error instanceof errors.DebugError) {
    // `invalid.js: Some debug error message`
    context.logger.error(`${filename}: ${error.message}`);
  } else {
    // `invalid.js: Error: Some unexpected error\n[stack trace]`
    /* istanbul ignore next */
    context.logger.error(filename + ": " + (error.stack || error));
  }

  // Don't exit the process if one file failed
  process.exitCode = 2;
}

function writeOutput(context, result, options) {
  // Don't use `console.log` here since it adds an extra newline at the end.
  process.stdout.write(
    context.argv.debugCheck ? result.filepath : result.formatted
  );

  if (options && options.cursorOffset >= 0) {
    process.stderr.write(result.cursorOffset + "\n");
  }
}

async function listDifferent(context, input, options, filename) {
  if (!context.argv.check && !context.argv.listDifferent) {
    return;
  }

  try {
    if (!options.filepath && !options.parser) {
      throw new errors.UndefinedParserError(
        "No parser and no file path given, couldn't infer a parser."
      );
    }
    if (!(await prettier.check(input, options))) {
      if (!context.argv.write) {
        context.logger.log(filename);
        process.exitCode = 1;
      }
    }
  } catch (error) {
    context.logger.error(error.message);
  }

  return true;
}

function getPerformanceTestFlag(context) {
  if (context.argv.debugBenchmark) {
    return "--debug-benchmark";
  }

  if (context.argv.debugRepeat > 0) {
    return "--debug-repeat";
  }
}

async function format(context, input, opt) {
  if (!opt.parser && !opt.filepath) {
    throw new errors.UndefinedParserError(
      "No parser and no file path given, couldn't infer a parser."
    );
  }

  if (context.argv.debugPrintDoc) {
    const doc = prettier.__debug.printToDoc(input, opt);
    return { formatted: (await prettier.__debug.formatDoc(doc)) + "\n" };
  }

  if (context.argv.debugPrintComments) {
    return {
      formatted: await prettier.format(
        JSON.stringify(
          (await prettier.formatWithCursor(input, opt)).comments || []
        ),
        { parser: "json" }
      ),
    };
  }

  if (context.argv.debugPrintAst) {
    const { ast } = prettier.__debug.parse(input, opt);
    return {
      formatted: JSON.stringify(ast),
    };
  }

  if (context.argv.debugCheck) {
    const pp = await prettier.format(input, opt);
    const pppp = await prettier.format(pp, opt);
    if (pp !== pppp) {
      throw new errors.DebugError(
        "prettier(input) !== prettier(prettier(input))\n" +
          (await diff(pp, pppp))
      );
    } else {
      const stringify = (obj) => JSON.stringify(obj, null, 2);
      const ast = stringify(
        prettier.__debug.parse(input, opt, /* massage */ true).ast
      );
      const past = stringify(
        prettier.__debug.parse(pp, opt, /* massage */ true).ast
      );

      /* istanbul ignore next */
      if (ast !== past) {
        const MAX_AST_SIZE = 2097152; // 2MB
        const astDiff =
          ast.length > MAX_AST_SIZE || past.length > MAX_AST_SIZE
            ? "AST diff too large to render"
            : await diff(ast, past);
        throw new errors.DebugError(
          "ast(input) !== ast(prettier(input))\n" +
            astDiff +
            "\n" +
            (await diff(input, pp))
        );
      }
    }
    return { formatted: pp, filepath: opt.filepath || "(stdin)\n" };
  }

  /* istanbul ignore next */
  if (context.argv.debugBenchmark) {
    let benchmark;
    try {
      // eslint-disable-next-line import/no-extraneous-dependencies
      ({ default: benchmark } = await import("benchmark"));
    } catch {
      context.logger.debug(
        "'--debug-benchmark' requires the 'benchmark' package to be installed."
      );
      process.exit(2);
    }
    context.logger.debug(
      "'--debug-benchmark' option found, measuring formatWithCursor with 'benchmark' module."
    );
    const suite = new benchmark.Suite();
    suite.add("format", {
      defer: true,
      async fn(deferred) {
        await prettier.formatWithCursor(input, opt);
        deferred.resolve();
      },
    });
    const result = await new Promise((resolve) => {
      suite
        .on("complete", (event) => {
          resolve({
            benchmark: String(event.target),
            hz: event.target.hz,
            ms: event.target.times.cycle * 1000,
          });
        })
        .run({ async: false });
    });
    context.logger.debug(
      "'--debug-benchmark' measurements for formatWithCursor: " +
        JSON.stringify(result, null, 2)
    );
  } else if (context.argv.debugRepeat > 0) {
    const repeat = context.argv.debugRepeat;
    context.logger.debug(
      "'--debug-repeat' option found, running formatWithCursor " +
        repeat +
        " times."
    );
    let totalMs = 0;
    for (let i = 0; i < repeat; ++i) {
      // should be using `performance.now()`, but only `Date` is cross-platform enough
      const startMs = Date.now();
      await prettier.formatWithCursor(input, opt);
      totalMs += Date.now() - startMs;
    }
    const averageMs = totalMs / repeat;
    const results = {
      repeat,
      hz: 1000 / averageMs,
      ms: averageMs,
    };
    context.logger.debug(
      "'--debug-repeat' measurements for formatWithCursor: " +
        JSON.stringify(results, null, 2)
    );
  }

  return prettier.formatWithCursor(input, opt);
}

async function createIgnorerFromContextOrDie(context) {
  try {
    return await createIgnorer(
      context.argv.ignorePath,
      context.argv.withNodeModules
    );
  } catch (e) {
    context.logger.error(e.message);
    process.exit(2);
  }
}

async function formatStdin(context) {
  const filepath = context.argv.filepath
    ? path.resolve(process.cwd(), context.argv.filepath)
    : process.cwd();

  const ignorer = await createIgnorerFromContextOrDie(context);
  // If there's an ignore-path set, the filename must be relative to the
  // ignore path, not the current working directory.
  const relativeFilepath = context.argv.ignorePath
    ? path.relative(path.dirname(context.argv.ignorePath), filepath)
    : path.relative(process.cwd(), filepath);

  try {
    const input = await getStdin();

    if (
      relativeFilepath &&
      ignorer.ignores(fixWindowsSlashes(relativeFilepath))
    ) {
      writeOutput(context, { formatted: input });
      return;
    }

    const options = await getOptionsForFile(context, filepath);

    if (await listDifferent(context, input, options, "(stdin)")) {
      return;
    }

    const formatted = await format(context, input, options);

    const performanceTestFlag = getPerformanceTestFlag(context);
    if (performanceTestFlag) {
      context.logger.log(
        `'${performanceTestFlag}' option found, skipped print code to screen.`
      );
      return;
    }

    writeOutput(context, formatted, options);
  } catch (error) {
    handleError(context, relativeFilepath || "stdin", error);
  }
}

async function formatFiles(context) {
  // The ignorer will be used to filter file paths after the glob is checked,
  // before any files are actually written
  const ignorer = await createIgnorerFromContextOrDie(context);

  let numberOfUnformattedFilesFound = 0;

  if (context.argv.check && !getPerformanceTestFlag(context)) {
    context.logger.log("Checking formatting...");
  }

  for await (const pathOrError of expandPatterns(context)) {
    if (typeof pathOrError === "object") {
      context.logger.error(pathOrError.error);
      // Don't exit, but set the exit code to 2
      process.exitCode = 2;
      continue;
    }

    const filename = pathOrError;
    // If there's an ignore-path set, the filename must be relative to the
    // ignore path, not the current working directory.
    const ignoreFilename = context.argv.ignorePath
      ? path.relative(path.dirname(context.argv.ignorePath), filename)
      : filename;

    const fileIgnored = ignorer.ignores(fixWindowsSlashes(ignoreFilename));
    if (
      fileIgnored &&
      (context.argv.debugCheck ||
        context.argv.write ||
        context.argv.check ||
        context.argv.listDifferent)
    ) {
      continue;
    }

    const options = {
      ...(await getOptionsForFile(context, filename)),
      filepath: filename,
    };

    let printedFilename;
    if (isTTY()) {
      printedFilename = context.logger.log(filename, {
        newline: false,
        clearable: true,
      });
    }

    let input;
    try {
      input = await fs.readFile(filename, "utf8");
    } catch (error) {
      // Add newline to split errors from filename line.
      /* istanbul ignore next */
      context.logger.log("");

      /* istanbul ignore next */
      context.logger.error(
        `Unable to read file: ${filename}\n${error.message}`
      );

      // Don't exit the process if one file failed
      /* istanbul ignore next */
      process.exitCode = 2;

      /* istanbul ignore next */
      continue;
    }

    if (fileIgnored) {
      writeOutput(context, { formatted: input }, options);
      continue;
    }

    const start = Date.now();

    let result;
    let output;

    try {
      result = await format(context, input, options);
      output = result.formatted;
    } catch (error) {
      handleError(context, filename, error, printedFilename);
      continue;
    }

    const isDifferent = output !== input;

    if (printedFilename) {
      // Remove previously printed filename to log it with duration.
      printedFilename.clear();
    }

    const performanceTestFlag = getPerformanceTestFlag(context);
    if (performanceTestFlag) {
      context.logger.log(
        `'${performanceTestFlag}' option found, skipped print code or write files.`
      );
      return;
    }

    if (context.argv.write) {
      // Don't write the file if it won't change in order not to invalidate
      // mtime based caches.
      if (isDifferent) {
        if (!context.argv.check && !context.argv.listDifferent) {
          context.logger.log(`${filename} ${Date.now() - start}ms`);
        }

        try {
          await fs.writeFile(filename, output, "utf8");
        } catch (error) {
          /* istanbul ignore next */
          context.logger.error(
            `Unable to write file: ${filename}\n${error.message}`
          );

          // Don't exit the process if one file failed
          /* istanbul ignore next */
          process.exitCode = 2;
        }
      } else if (!context.argv.check && !context.argv.listDifferent) {
        context.logger.log(`${chalk.grey(filename)} ${Date.now() - start}ms`);
      }
    } else if (context.argv.debugCheck) {
      /* istanbul ignore else */
      if (result.filepath) {
        context.logger.log(result.filepath);
      } else {
        process.exitCode = 2;
      }
    } else if (!context.argv.check && !context.argv.listDifferent) {
      writeOutput(context, result, options);
    }

    if (isDifferent) {
      if (context.argv.check) {
        context.logger.warn(filename);
      } else if (context.argv.listDifferent) {
        context.logger.log(filename);
      }
      numberOfUnformattedFilesFound += 1;
    }
  }

  // Print check summary based on expected exit code
  if (context.argv.check) {
    if (numberOfUnformattedFilesFound === 0) {
      context.logger.log("All matched files use Prettier code style!");
    } else if (numberOfUnformattedFilesFound === 1) {
      context.logger.warn(
        context.argv.write
          ? "Code style issues fixed in the above file."
          : "Code style issues found in the above file. Forgot to run Prettier?"
      );
    } else {
      context.logger.warn(
        context.argv.write
          ? "Code style issues found in " +
              numberOfUnformattedFilesFound +
              " files."
          : "Code style issues found in " +
              numberOfUnformattedFilesFound +
              " files. Forgot to run Prettier?"
      );
    }
  }

  // Ensure non-zero exitCode when using --check/list-different is not combined with --write
  if (
    (context.argv.check || context.argv.listDifferent) &&
    numberOfUnformattedFilesFound > 0 &&
    !process.exitCode &&
    !context.argv.write
  ) {
    process.exitCode = 1;
  }
}

export { formatStdin, formatFiles };
