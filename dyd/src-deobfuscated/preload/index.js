const Addon=require("ee-core/addon");
module.exports=async()=>{
  Addon.get("security").create();
};
