// The parameter hints popup: what call the cursor is inside, and which argument
// is being typed.
//
// A different question from completion and answered by a different thing. A
// suggestion list says what could go here; this says what the call expects, and
// stays up while the arguments are typed - which is what a build123d signature
// is actually needed for, because Box(10, 10, 10) is three numbers that mean
// length, width and height and nothing on screen otherwise says so.
//
// jedi alone, not the kernel. The kernel's inspect_request answers with a block
// of formatted text, and the popup highlights the parameter being typed, which
// needs the parameters as a list and an index rather than a paragraph. jedi
// gives both, and gives them for a call whose function has never been run.

/**
 * Turn the sidecar's answer into Monaco's SignatureHelp.
 *
 * The shapes are close enough that this is mostly renaming, and the one piece
 * of real work is the parameter labels: Monaco takes each as a string to find
 * inside the signature label, and highlights the match. jedi writes them in the
 * same form it writes the signature, so they are found.
 *
 * @param {object|null} frame the editor.signature reply
 * @returns {object|null} SignatureHelp, or null when the cursor is in no call
 */
export function signatureHelp(frame) {
  const signature = frame === null || frame === undefined ? null : frame.signature;
  if (signature === null || signature === undefined || !Array.isArray(signature.signatures)) {
    return null;
  }
  const signatures = signature.signatures.map((entry) => ({
    label: entry.label ?? "",
    documentation: entry.documentation === "" ? undefined : entry.documentation,
    parameters: (entry.parameters ?? []).map((label) => ({ label })),
  }));
  if (signatures.length === 0) {
    return null;
  }

  return {
    signatures,
    activeSignature: clamp(signature.activeSignature, signatures.length),
    // -1 is "the cursor is past every parameter this signature has", which
    // happens with *args and while a mistake is being typed. Monaco highlights
    // nothing for an index it cannot find, which is the honest rendering.
    activeParameter: signature.activeParameter,
  };
}

function clamp(index, length) {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    return 0;
  }
  return index;
}
