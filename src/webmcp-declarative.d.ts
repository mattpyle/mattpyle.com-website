/**
 * The declarative WebMCP attributes, taught to Astro's JSX types.
 *
 * `toolname` and `tooldescription` on a `<form>` and `toolparamdescription` on its controls are
 * how a page declares a WebMCP tool in markup rather than registering it in script. They are not
 * in the HTML standard, so `FormHTMLAttributes` and `InputHTMLAttributes` do not carry them and
 * `astro check` refuses the attribute outright — which is a real signal, not a nuisance: an
 * off-spec attribute should have to be declared once, deliberately, in a file that says what it is
 * and where the claim comes from.
 *
 * MEASURED, on Chrome 152.0.7977.76 against production on 2026-09-06. A form carrying `toolname`
 * and `tooldescription`, with `toolparamdescription` on its input, is listed by
 * `document.modelContext.getTools()` beside the tools registered in script, with `inputSchema`
 * built by Chrome from the form's own controls. A form with no `toolname` registers nothing, and
 * removing the form deregisters the tool.
 *
 * Declared as optional on the generic element interfaces rather than only where /audit uses them,
 * because the next form to declare a tool should not have to find this file first — and because a
 * type that says "only this one form may" would be a claim about the site, not about HTML.
 *
 * `npm run validate:html` sees the same off-spec attributes and the Nu checker reports them; see
 * docs/reference/html-validity-and-llms-txt.md for that side of it.
 */
declare namespace astroHTML.JSX {
  interface FormHTMLAttributes {
    /** The tool's name, as an agent sees it in `document.modelContext.getTools()`. */
    toolname?: string;
    /** What calling the tool does, written to be read out of context in a list of tools. */
    tooldescription?: string;
  }

  interface HTMLAttributes {
    /** What this control's value means, as the description of its property in the input schema. */
    toolparamdescription?: string;
  }
}
