//////////////////////////////////////////////////////////////////////////////////
// Module Name: uart_byte_tx
//
// 功能：
//   UART 单字节发送模块
//
// 默认系统时钟：
//   50 MHz
//
// baud_set：
//   0 -> 9600
//   1 -> 19200
//   2 -> 38400
//   3 -> 57600
//   4 -> 115200
//
// 使用方法：
//   1. uart_state == 0 时表示串口空闲
//   2. 将 data_byte 准备好
//   3. send_en 拉高 1 个 clk 周期
//   4. 模块开始发送 1 Byte
//   5. 发送完成后 tx_done 拉高 1 个 clk 周期
//
// 注意：
//   uart_state == 1 时，新的 send_en 会被忽略
//
// 兼容性：
//   保持原 uart_byte_tx 接口不变，原 uart_data_tx 可继续使用
//////////////////////////////////////////////////////////////////////////////////

module uart_byte_tx(
    clk,
    rst_n,

    data_byte,
    send_en,
    baud_set,

    uart_tx,
    tx_done,
    uart_state
);

    input             clk;
    input             rst_n;

    input      [7:0]  data_byte;
    input             send_en;
    input      [2:0]  baud_set;

    output reg        uart_tx;
    output reg        tx_done;
    output reg        uart_state;


    // ============================================================
    // UART 参数
    // ============================================================

    localparam START_BIT = 1'b0;
    localparam STOP_BIT  = 1'b1;


    // ============================================================
    // 内部寄存器
    // ============================================================

    reg [15:0] baud_div;
    reg [15:0] div_cnt;

    // bit_cnt:
    //
    // 0     Start
    // 1~8   Data[0] ~ Data[7]
    // 9     Stop
    //
    reg [3:0] bit_cnt;

    reg [7:0] data_byte_reg;


    // ============================================================
    // 波特率设置
    //
    // 50 MHz 时钟
    //
    // 一个 bit 的时钟周期数：
    // baud_div + 1
    // ============================================================

    always @(*) begin

        case (baud_set)

            3'd0:
                baud_div = 16'd5207;    // 9600

            3'd1:
                baud_div = 16'd2603;    // 19200

            3'd2:
                baud_div = 16'd1301;    // 38400

            3'd3:
                baud_div = 16'd867;     // 57600

            3'd4:
                baud_div = 16'd433;     // 115200

            default:
                baud_div = 16'd5207;

        endcase

    end


    // ============================================================
    // UART TX 主逻辑
    //
    // 8N1:
    //
    // Start
    // D0
    // D1
    // ...
    // D7
    // Stop
    //
    // UART 数据位是低位先发
    // ============================================================

    always @(posedge clk or negedge rst_n) begin

        if (!rst_n) begin

            uart_tx       <= 1'b1;

            tx_done       <= 1'b0;
            uart_state    <= 1'b0;

            div_cnt       <= 16'd0;
            bit_cnt       <= 4'd0;

            data_byte_reg <= 8'd0;

        end

        else begin

            // tx_done 为单周期脉冲
            tx_done <= 1'b0;


            // ====================================================
            // UART 空闲
            // ====================================================

            if (!uart_state) begin

                uart_tx <= 1'b1;

                div_cnt <= 16'd0;
                bit_cnt <= 4'd0;


                // 只有空闲时才接受发送请求
                if (send_en) begin

                    // 锁存待发送数据
                    data_byte_reg <= data_byte;

                    uart_state <= 1'b1;

                    // 立即进入起始位
                    uart_tx <= START_BIT;

                end

            end


            // ====================================================
            // UART 正在发送
            // ====================================================

            else begin

                if (div_cnt >= baud_div) begin

                    div_cnt <= 16'd0;


                    case (bit_cnt)

                        // Start 已发送完成
                        // 开始发送 Data[0]
                        4'd0:
                        begin

                            uart_tx <= data_byte_reg[0];

                            bit_cnt <= 4'd1;

                        end


                        4'd1:
                        begin

                            uart_tx <= data_byte_reg[1];

                            bit_cnt <= 4'd2;

                        end


                        4'd2:
                        begin

                            uart_tx <= data_byte_reg[2];

                            bit_cnt <= 4'd3;

                        end


                        4'd3:
                        begin

                            uart_tx <= data_byte_reg[3];

                            bit_cnt <= 4'd4;

                        end


                        4'd4:
                        begin

                            uart_tx <= data_byte_reg[4];

                            bit_cnt <= 4'd5;

                        end


                        4'd5:
                        begin

                            uart_tx <= data_byte_reg[5];

                            bit_cnt <= 4'd6;

                        end


                        4'd6:
                        begin

                            uart_tx <= data_byte_reg[6];

                            bit_cnt <= 4'd7;

                        end


                        4'd7:
                        begin

                            uart_tx <= data_byte_reg[7];

                            bit_cnt <= 4'd8;

                        end


                        // Data[7]发送完成
                        // 开始发送停止位
                        4'd8:
                        begin

                            uart_tx <= STOP_BIT;

                            bit_cnt <= 4'd9;

                        end


                        // Stop Bit 已保持完整一个bit周期
                        4'd9:
                        begin

                            uart_tx <= 1'b1;

                            uart_state <= 1'b0;

                            tx_done <= 1'b1;

                            bit_cnt <= 4'd0;

                        end


                        default:
                        begin

                            uart_tx <= 1'b1;

                            uart_state <= 1'b0;

                            bit_cnt <= 4'd0;

                        end

                    endcase

                end

                else begin

                    div_cnt <= div_cnt + 16'd1;

                end

            end

        end

    end


endmodule