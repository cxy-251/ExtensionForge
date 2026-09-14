'use strict';
const {
  Controller
}=require("ee-core"),Services=require("ee-core/services");
class VxController extends Controller{
  constructor(_0x393468){
    super(_0x393468);
  }async.isBind(_0x44cf32,_0x48f0e2){
    return await Services.get('vx').isBind(_0x44cf32);
  }async.getRoomMsgList(_0x465abc,_0x3ec323){
    return await Services.get('vx').getRoomMsgList(_0x465abc);
  }
}VxController.toString=()=>"[class VxController]",module.exports=VxController;
