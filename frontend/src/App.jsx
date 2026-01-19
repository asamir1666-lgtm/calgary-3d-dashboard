export default function ThreeMap({
  buildings,
  matchedIds,
  selectedBuildingId,
  onSelectBuilding,
}) {
  // when user clicks a building:
  function handleBuildingClick(building) {
    onSelectBuilding?.(building.id); // or building.building_id depending on your data
    // optional: also move camera / outline selection
  }

  // use selectedBuildingId to visually outline / focus
}
