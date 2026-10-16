/** Marks a cell type that belongs to another die of the cell library (its
 *  owner named in the tooltip). */
export function OtherDieBadge({ owner }: { owner: string }) {
  return (
    <span
      className="chip on"
      title={`Cell type of ${owner}, shared through the cell library`}
      style={{
        height: 14,
        padding: "0 5px",
        marginLeft: 6,
        fontSize: 9,
        flex: "0 0 auto",
        verticalAlign: "middle"
      }}
    >
      other die
    </span>
  );
}
