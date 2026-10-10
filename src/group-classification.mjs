// Sony group IDs do not prove DLC: collections may split core games into groups.
// Only the previously verified Witcher PS5 DLC mapping is retained here.
export const trophyGroupKind=(setId,sonyGroupId)=>sonyGroupId==='default'?'base':setId==='NPWR24698_00'&&['001','002'].includes(sonyGroupId)?'dlc':'additional';
